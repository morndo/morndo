// The apply service's contract (design §6.2–§6.5; RL4–RL9, RL13): the whole step order against the real installer,
// the real store, real SQLite databases and a real hold.json, with only the machine's services and probes faked.
// Each case bends one thing and asserts the outcome, what was touched (the tape holds every call in order), and
// what the record says afterwards. The kill-and-recover cases live in recovery-service.test.ts (§6.6).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readHold, writeFloor } from "@morndo/service-kit";
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

  it("carries the applying mark from the drain to the commit (§5)", async () => {
    // §5: the mark exists from the drain until the Update commits, and the recovery unit runs only while it does.
    // The probe stands where a service would: what it observes under the drain's hold is what the machine saw.
    const w = await buildApplyWorld(scratch);
    const seen: boolean[] = [];
    w.probe.safePointScript = (s) => {
      if (holdText(w.holdPath) !== null) seen.push(w.applying.present());
      return { service: s, blockers: [] };
    };
    expect(w.applying.present(), "nothing is marked before the drain").toBe(false);
    expect(await w.apply().apply({ now: false })).toEqual({ kind: "committed", version: B });
    expect(seen.length, "the drain read the safe point under the hold").toBeGreaterThan(0);
    expect(seen.every(present => present), "the mark stood through the drain").toBe(true);
    expect(w.applying.present(), "the mark is gone once committed").toBe(false);
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
    expect(third.applying.present(), "a deferred attempt leaves no mark (§5)").toBe(false);
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
    expect(w.applying.present(), "the drain never began, so no mark (§5)").toBe(false);
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
    expect(w.applying.present(), "an abandoned attempt leaves no mark (§5)").toBe(false);
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
    expect(w.applying.present(), "a rolled-back attempt leaves no mark (§5)").toBe(false);
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
    expect(w.applying.present(), "a failed rollback still ended, so no mark (§5)").toBe(false);
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
    expect(w.applying.present(), "a waiting rollback keeps its mark: recovery must run again (§5)").toBe(true);
    // tmux moves out of the unit; the recovery finishes what the apply could not
    w.services.tmuxIn = false;
    const recovered = await w.recover().recover();
    expect(recovered).toMatchObject({ kind: "rolled_back", version: A });
    expect(w.current()).toBe(A);
    expect(w.installer.layout()).toMatchObject({ current: A, previous: null });   // the pair there was before
    expect(w.applying.present(), "the mark is gone once the rollback ended").toBe(false);
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
    w.store.recordCommitted(B, w.timeline.now(), null);      // B is already the committed ceiling
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

  // ---- the review of 2026-10-21 (md-rev5 on #101)

  it("waits for each service's acknowledgement of the hold before it judges the drain", async () => {
    // The services re-read hold.json every second (service-kit HoldWatch) and say so in their health (`held`): a
    // safe-point read before a service has seen the hold can pass while it still takes new work. The world's services
    // acknowledge one re-read interval after the write; no read under the hold comes before that.
    const w = await buildApplyWorld(scratch);
    const sinceHold: number[] = [];
    w.probe.safePointScript = (s) => {
      const text = holdText(w.holdPath);
      if (text !== null) sinceHold.push(w.timeline.now() - Date.parse((JSON.parse(text) as { since: string }).since));
      return { service: s, blockers: [] };
    };
    expect(await w.apply().apply({ now: false })).toEqual({ kind: "committed", version: B });
    expect(sinceHold.length, "the drain read the safe point under the hold").toBeGreaterThan(0);
    expect(Math.min(...sinceHold), "no read under the hold before the services' re-read interval").toBeGreaterThanOrEqual(1_000);
  });

  it("re-checks the services at the end of probation, and a service that went down rolls back", async () => {
    const w = await buildApplyWorld(scratch);
    const answeredAtB = new Map<string, number>();
    w.probe.healthScript = (s) => {
      if (w.current() !== B) return { service: s, version: w.current() ?? A, checks: { ready: true, database: true } };
      const n = (answeredAtB.get(s) ?? 0) + 1;
      answeredAtB.set(s, n);
      // healthy when first asked at B, gone once probation has run
      return n === 1 || s !== "node" ? { service: s, version: B, checks: { ready: true, database: true } } : null;
    };
    const out = await w.apply().apply({ now: false });
    expect(out).toMatchObject({ kind: "rolled_back", version: A });
    if (out.kind !== "rolled_back") throw new Error("unreachable");
    expect(out.reason).toContain("node");
  });

  it("a rollback halts the Version's rollout on record", async () => {
    const w = await buildApplyWorld(scratch);
    w.services.restartCounts = { hub: 1 };
    expect(await w.apply().apply({ now: false })).toMatchObject({ kind: "rolled_back", version: A });
    expect(w.store.halts().map(h => h.version)).toEqual([B]);
  });

  it("refuses a restore that would drop a revocation made during probation, with the alert", async () => {
    // RL10 before the journals (5c): the fleet's nodes table holds a node that is revoked while B is on probation; a
    // restore of the fleet's Backup would bring it back. The rollback refuses, raises the alert, and touches nothing.
    const w = await buildApplyWorld(scratch, { bSchemas: SCHEMAS_B_FLEET_FLOOR });
    const fleet = new Database(w.dbPaths.fleet);
    fleet.exec("CREATE TABLE nodes (name TEXT PRIMARY KEY, revoked_at INTEGER)");
    fleet.prepare("INSERT INTO nodes (name, revoked_at) VALUES (?, NULL)").run("node-b");
    fleet.close();
    w.services.onStart = (s, current) => {
      if (s !== "fleet" || current !== B) return;
      const db = new Database(w.dbPaths.fleet);
      db.pragma("user_version = 3");
      writeFloor(db, 3);
      db.prepare("UPDATE nodes SET revoked_at = ? WHERE name = ?").run(1, "node-b");   // revoked during probation
      db.close();
    };
    w.probe.healthScript = (s) =>
      s === "hub" && w.current() === B ? null : { service: s, version: w.current() ?? A, checks: { ready: true, database: true } };
    const stopsBefore = (): number => w.tape.filter(t => t.startsWith("stop:")).length;
    const out = await w.apply().apply({ now: false });
    expect(out).toMatchObject({ kind: "rollback_failed" });
    if (out.kind !== "rollback_failed") throw new Error("unreachable");
    expect(out.reason).toContain("nodes:node-b");
    expect(w.tape).not.toContain("backup:restore:fleet");
    expect(w.alerts.raised.some(a => a.kind === "update_rollback_failed" && a.detail.includes("revocation"))).toBe(true);
    expect(stopsBefore(), "the target was stopped only once, for the update itself").toBe(3);
    const db = new Database(w.dbPaths.fleet, { readonly: true });
    try { expect(db.prepare("SELECT revoked_at FROM nodes WHERE name = 'node-b'").get()).toEqual({ revoked_at: 1 }); }
    finally { db.close(); }
  });

  it("keeps the probation hold fresh while a rollback waits on tmux", async () => {
    // §5: a hold older than 10 minutes is ignored. A rollback that waits (RL13) must keep holding the writes a later
    // restore would drop: each recovery run while it waits takes the hold again.
    const w = await buildApplyWorld(scratch, { bSchemas: SCHEMAS_B_FLEET_FLOOR });
    w.probe.healthScript = (s) => {
      if (s === "hub" && w.current() === B) {
        w.services.tmuxIn = true;                             // by now tmux sits in the agent's unit
        return null;
      }
      return { service: s, version: w.current() ?? A, checks: { ready: true, database: true } };
    };
    expect(await w.apply().apply({ now: false })).toMatchObject({ kind: "rollback_waiting" });
    w.timeline.nowMs += 6 * 60_000;
    expect(await w.recover().recover()).toMatchObject({ kind: "rollback_waiting" });
    w.timeline.nowMs += 6 * 60_000;                           // 12 minutes after the first hold
    const view = readHold({ path: w.holdPath, service: "fleet", now: w.timeline.now() });
    expect(view.kind, "still held, not stale").toBe("held");
  });


  // ---- the second review of 2026-10-21 (md-rev5 on #101 at 679be5a)

  it("a service that never acknowledges the hold defers the apply, with the hold lifted and nothing stopped", async () => {
    const w = await buildApplyWorld(scratch);
    w.probe.seesHoldScript = (s) => s !== "fleet";            // the fleet never says it has seen the hold
    const out = await w.apply().apply({ now: false });
    expect(out).toMatchObject({ kind: "deferred" });
    if (out.kind !== "deferred") throw new Error("unreachable");
    expect(out.blockers.join(" ")).toContain("fleet");
    expect(w.tape.some(t => t.startsWith("stop:"))).toBe(false);
    expect(holdText(w.holdPath)).toBeNull();
    expect(w.current()).toBe(A);
  });

  it("a rollback that fails records the target bad and halts its rollout, then raises the alert", async () => {
    const w = await buildApplyWorld(scratch);
    let seenB = false;
    w.probe.healthScript = (s) => {
      const at = w.current();
      if (at === B) { seenB = true; return s === "hub" ? null : { service: s, version: B, checks: { ready: true, database: true } }; }
      if (seenB) return { service: s, version: A, checks: { ready: false, database: true } };   // A will not come back either
      return { service: s, version: at ?? A, checks: { ready: true, database: true } };
    };
    expect(await w.apply().apply({ now: false })).toMatchObject({ kind: "rollback_failed" });
    expect(w.store.badVersions()).toContain(B);
    expect(w.store.halts().map(h => h.version)).toEqual([B]);
    expect(w.alerts.raised.some(a => a.kind === "update_rollback_failed")).toBe(true);
  });

  it("a revocation that lands while the services stop is still never dropped by a restore", async () => {
    // The first check runs before the stop; a revoke can land between it and the stop. The check runs again once
    // nothing runs any more, and refuses then: the target's services start again and the rollback fails loudly.
    const w = await buildApplyWorld(scratch, { bSchemas: SCHEMAS_B_FLEET_FLOOR });
    const fleet = new Database(w.dbPaths.fleet);
    fleet.exec("CREATE TABLE nodes (name TEXT PRIMARY KEY, revoked_at INTEGER)");
    fleet.prepare("INSERT INTO nodes (name, revoked_at) VALUES (?, NULL)").run("node-c");
    fleet.close();
    w.services.onStart = (s, current) => {
      if (s !== "fleet" || current !== B) return;
      const db = new Database(w.dbPaths.fleet);
      db.pragma("user_version = 3");
      writeFloor(db, 3);
      db.close();
    };
    let stopsAtB = 0;
    w.services.onStop = (s, current) => {
      if (current !== B || s !== "fleet") return;
      stopsAtB += 1;
      const db = new Database(w.dbPaths.fleet);
      db.prepare("UPDATE nodes SET revoked_at = ? WHERE name = ?").run(2, "node-c");     // the last write before the stop
      db.close();
    };
    w.probe.healthScript = (s) =>
      s === "hub" && w.current() === B ? null : { service: s, version: w.current() ?? A, checks: { ready: true, database: true } };
    const out = await w.apply().apply({ now: false });
    expect(stopsAtB).toBe(1);
    expect(out).toMatchObject({ kind: "rollback_failed" });
    if (out.kind !== "rollback_failed") throw new Error("unreachable");
    expect(out.reason).toContain("nodes:node-c");
    expect(w.tape).not.toContain("backup:restore:fleet");
    expect(w.current(), "the links never moved back").toBe(B);
    const after = w.tape.slice(w.tape.lastIndexOf("stop:fleet"));
    expect(after.filter(t => t.startsWith("start:")).length, "the target's services started again").toBe(3);
  });


  it("refuses to restore a connections store whose backup is older than a revocation of a connection", async () => {
    // B migrates the connections store with a raised floor, so a rollback would restore its backup; a connection
    // revoked during probation lives only in the live store's directory JSON. The restore is refused.
    const w = await buildApplyWorld(scratch, { bSchemas: { ...SCHEMAS_A, connections: { version: 2, floor: 2 } } });
    const directory = (status: string) => JSON.stringify({ connections: [{ name: "vendor-a", status }], events: [], seq: 2 });
    const store = new Database(w.dbPaths.connections);
    store.exec("CREATE TABLE directory (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)");
    store.prepare("INSERT INTO directory (id, body) VALUES (1, ?)").run(directory("on"));
    store.close();
    w.services.onStart = (s, current) => {
      if (s !== "fleet" || current !== B) return;                   // B is up: its helper migrated the store, then a revoke
      const db = new Database(w.dbPaths.connections);
      db.pragma("user_version = 2");
      writeFloor(db, 2);
      db.prepare("UPDATE directory SET body = ? WHERE id = 1").run(directory("revoked"));
      db.close();
    };
    w.probe.healthScript = (s) =>
      s === "hub" && w.current() === B ? null : { service: s, version: w.current() ?? A, checks: { ready: true, database: true } };
    const out = await w.apply().apply({ now: false });
    expect(out).toMatchObject({ kind: "rollback_failed" });
    if (out.kind !== "rollback_failed") throw new Error("unreachable");
    expect(out.reason).toContain("directory:vendor-a");
    expect(w.tape).not.toContain("backup:restore:connections");
  });


  // ---- the review of 2026-10-22 on #104: a machine's own units only

  it("renders only the units of the machine's own services: a node machine gets no hub or fleet units", async () => {
    const w = await buildApplyWorld(scratch, { running: ["node"] });
    w.probe.healthScript = (s) => s === "node" && w.current() === B
      ? { service: s, version: A, checks: { ready: true, database: true } }      // forces the rollback's render too
      : { service: s, version: w.current() ?? A, checks: { ready: true, database: true } };
    await w.apply().apply({ now: false });
    const renders = w.tape.filter(t => t.startsWith("renderUnits:"));
    expect(renders.length, "the swap's render and the rollback's").toBe(2);
    for (const r of renders) expect(r, "every render names the machine's services: node only").toMatch(/\(node\)$/);
  });

});
