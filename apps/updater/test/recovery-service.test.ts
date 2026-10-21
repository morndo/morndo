// The recovery unit's contract (design §6.6): whatever a crash left mid-apply — a hold on the machine, a record
// stopped at a mark, a swap that landed — the next process reads the record from disk and finishes the attempt one
// way or the other: the old Version healthy again, or the target committed, never a mix. The kills are real
// interruptions of a real apply over the real installer, store and databases — §13's power-loss row for every
// mark — and each row of the §6.6 table gets its own case.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { UPDATE_MARKS, type UpdateMark, type UpdateService } from "@morndo/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApplyInterrupted } from "../src/application/apply-steps.ts";
import {
  A, B, buildApplyWorld, dbFingerprint, holdText, SCHEMAS_B_FLEET_FLOOR, type ApplyWorld, type Die,
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

// Arms the die, runs the apply, and proves it died mid-step with the record left open: a dead process, not a refusal.
const killedApply = async (w: ApplyWorld, arm: (die: Die) => void): Promise<void> => {
  arm(w.die);
  let interrupted = false;
  try { await w.apply().apply({ now: false }); } catch (error) { interrupted = error instanceof ApplyInterrupted; }
  w.die.on = null;
  w.die.after = null;
  expect(interrupted, "the apply died mid-step").toBe(true);
  expect(w.store.openUpdate(), "the record stands open at its mark").not.toBeNull();
};

// One service never answers at the target: the health judge's no_report, on the apply's road and recovery's alike.
const sickAtB = (w: ApplyWorld, s0: UpdateService): void => {
  w.probe.healthScript = (s) => (s === s0 && w.current() === B ? null
    : { service: s, version: w.current() ?? A, checks: { ready: true, database: true } });
};

// §13's own bar: the end is a Version, whole — the databases open, the hold gone, the record terminal, and every
// service answering at the Version that is current. A mix fails something here.
const endsWhole = async (w: ApplyWorld, version: string, state: string): Promise<void> => {
  expect(w.current()).toBe(version);
  for (const path of Object.values(w.dbPaths)) expect(quickCheck(path)).toBe("ok");
  expect(holdText(w.holdPath)).toBeNull();
  expect(w.store.openUpdate()).toBeNull();
  expect(w.store.recentUpdates(1)[0]!.state).toBe(state);
  for (const s of w.services.services()) {
    const report = await w.probe.health(s);
    expect(report, `${s} answers at ${version}`).not.toBeNull();
    if (report === null) throw new Error("unreachable");
    expect(report.version, `${s} runs the current Version`).toBe(version);
    expect(Object.values(report.checks).every(Boolean), `${s} is healthy`).toBe(true);
  }
};

// How each mark is reached and killed, and what the recovery must end at (§6.2's order decides the window).
const KILL_SPEC: Record<UpdateMark, {
  arm: (die: Die) => void; end: "A" | "B"; state: string; migration?: boolean; sick?: UpdateService;
}> = {
  draining: { arm: die => { die.on = { op: "write", call: 1 }; }, end: "A", state: "abandoned" },
  stopping: { arm: die => { die.on = { op: "stop", call: 1 }; }, end: "A", state: "abandoned" },
  backing_up: { arm: die => { die.on = { op: "take", call: 1 }; }, end: "A", state: "abandoned", migration: true },
  swapping: { arm: die => { die.on = { op: "swap" }; }, end: "A", state: "abandoned" },      // before the renames
  starting: { arm: die => { die.on = { op: "start", call: 1 }; }, end: "B", state: "committed" },
  committing: { arm: die => { die.on = { op: "clear", call: 2 }; }, end: "B", state: "committed" },
  rolling_back: { arm: die => { die.on = { op: "stop", call: 4 }; }, end: "A", state: "rolled_back", sick: "hub" },
};

describe("the recovery unit (§6.6, §13)", () => {
  it("answers nothing_open when no record stands", async () => {
    const w = await buildApplyWorld(scratch);
    expect(await w.recover().recover()).toEqual({ kind: "nothing_open" });
    expect(w.tape.length).toBe(0);
  });

  it("answers busy, doing nothing, when another process holds the apply lock", async () => {
    const w = await buildApplyWorld(scratch);
    await killedApply(w, die => { die.on = { op: "stop", call: 1 }; });
    const tapeAtKill = w.tape.length;
    expect(await w.recoverWithLockHeld().recover()).toEqual({ kind: "busy" });
    expect(w.tape.length).toBe(tapeAtKill);
    expect(w.store.openUpdate(), "the record still stands open").not.toBeNull();
  });

  for (const mark of UPDATE_MARKS) {
    const spec = KILL_SPEC[mark];
    it(`a kill at ${mark} recovers to ${spec.end === "A" ? A : B}, ${spec.state}`, async () => {
      const w = await buildApplyWorld(scratch, spec.migration === true ? { bSchemas: SCHEMAS_B_FLEET_FLOOR } : {});
      if (spec.sick !== undefined) sickAtB(w, spec.sick);
      await killedApply(w, spec.arm);
      const out = await w.recover().recover();
      if (spec.end === "B") expect(out).toEqual({ kind: "committed", version: B });
      else if (spec.state === "rolled_back") expect(out).toMatchObject({ kind: "rolled_back", version: A });
      else expect(out).toEqual({ kind: "abandoned" });
      await endsWhole(w, spec.end === "A" ? A : B, spec.state);
    });
  }

  it("a kill after the swap landed carries the apply on and commits", async () => {
    // §13's narrowest window: both renames done, the next mark not yet saved — the record still says swapping.
    const w = await buildApplyWorld(scratch);
    await killedApply(w, die => { die.after = { op: "swap" }; });
    expect(w.current()).toBe(B);
    expect(w.store.openUpdate()?.mark).toBe("swapping");
    expect(await w.recover().recover()).toEqual({ kind: "committed", version: B });
    await endsWhole(w, B, "committed");
  });

  it("a record at starting whose health fails at the target rolls back", async () => {
    const w = await buildApplyWorld(scratch);
    sickAtB(w, "hub");
    await killedApply(w, die => { die.on = { op: "start", call: 1 }; });
    const out = await w.recover().recover();
    expect(out).toMatchObject({ kind: "rolled_back", version: A });
    if (out.kind !== "rolled_back") throw new Error("unreachable");
    expect(out.reason).toContain("hub");
    expect(w.store.badVersions()).toContain(B);
    await endsWhole(w, A, "rolled_back");
  });

  it("a kill during a migration's rollback restores the backup on the way back", async () => {
    const w = await buildApplyWorld(scratch, { bSchemas: SCHEMAS_B_FLEET_FLOOR });
    const fleetBefore = dbFingerprint(w.dbPaths.fleet);
    let migrated = false;
    w.services.onStart = (s, current) => {
      if (s !== "fleet" || current !== B) return;            // B's fleet start runs B's migration
      const db = new Database(w.dbPaths.fleet);
      db.exec("INSERT INTO lanes (id) VALUES ('written-by-b')");
      db.pragma("user_version = 3");
      db.close();
      migrated = true;
    };
    sickAtB(w, "fleet");
    await killedApply(w, die => { die.on = { op: "stop", call: 4 }; });
    const out = await w.recover().recover();
    expect(migrated, "B's migration ran").toBe(true);
    expect(out).toMatchObject({ kind: "rolled_back", version: A });
    expect(w.tape).toContain("backup:take:fleet:ok");
    expect(w.tape).toContain("backup:restore:fleet");
    expect(dbFingerprint(w.dbPaths.fleet), "the backup went back in, whole").toEqual(fleetBefore);
    await endsWhole(w, A, "rolled_back");
  });

  it("acts on nothing, with the alert, for a record from a newer format", async () => {
    const w = await buildApplyWorld(scratch);
    await killedApply(w, die => { die.on = { op: "stop", call: 1 }; });
    const tapeAtKill = w.tape.length;
    const db = new Database(w.updateDb);
    try { db.prepare("UPDATE updates SET format = 2 WHERE finished_at IS NULL").run(); } finally { db.close(); }
    const out = await w.recover().recover();
    expect(out).toMatchObject({ kind: "unknown_record" });
    if (out.kind !== "unknown_record") throw new Error("unreachable");
    expect(out.detail).toContain("format 2");
    expect(w.alerts.raised.some(x => x.kind === "update_unknown_record" && x.detail.includes("format 2"))).toBe(true);
    expect(w.tape.length, "nothing was done to the machine").toBe(tapeAtKill);
    expect(w.store.openUpdate(), "the record stands untouched").not.toBeNull();
    expect(w.current()).toBe(A);
  });

  it("acts on nothing, with the alert, for a mark this Version does not know", async () => {
    const w = await buildApplyWorld(scratch);
    await killedApply(w, die => { die.on = { op: "stop", call: 1 }; });
    const db = new Database(w.updateDb);
    try {
      const row = db.prepare("SELECT id, record FROM updates WHERE finished_at IS NULL").get() as { id: string; record: string };
      const parsed = JSON.parse(row.record) as { mark: string | null };
      parsed.mark = "teleporting";                           // a newer build's step this one has never heard of
      db.prepare("UPDATE updates SET record = ? WHERE id = ?").run(JSON.stringify(parsed), row.id);
    } finally { db.close(); }
    const out = await w.recover().recover();
    expect(out).toMatchObject({ kind: "unknown_record" });
    if (out.kind !== "unknown_record") throw new Error("unreachable");
    expect(out.detail).toContain("teleporting");
    expect(w.alerts.raised.some(x => x.kind === "update_unknown_record" && x.detail.includes("teleporting"))).toBe(true);
    expect(w.store.openUpdate(), "the record stands untouched").not.toBeNull();
    expect(w.current()).toBe(A);
  });
});
