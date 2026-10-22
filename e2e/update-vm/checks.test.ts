// The throwaway-machine run's own judgements (checks.ts), tested without a machine: the leftover sweep against a
// real directory, the scratch migration's number, and the two log readings the scenario's checks rest on.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nextMigration, recoverUnitRan, saysDiskFull, sweepScratch } from "./checks.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const dir = () => { const d = mkdtempSync(join(tmpdir(), "morndo-e2e-checks-")); dirs.push(d); return d; };

// A temp directory as a killed run leaves it: a build scratch, a file of the same shape, names that only look alike.
const leftovers = () => {
  const d = dir();
  mkdirSync(join(d, "morndo-c2-build-AbC123"));
  writeFileSync(join(d, "morndo-c2-build-AbC123", "x"), "a copy of the repository");
  writeFileSync(join(d, "morndo-c2-build-XyZ789"), "a file, not a scratch directory");
  mkdirSync(join(d, "morndo-c2-build-notours-1"));
  mkdirSync(join(d, "morndo-c2-build-ab12"));
  mkdirSync(join(d, "someone-elses"));
  return d;
};

describe("sweepScratch", () => {
  it("removes only a real directory named exactly as the build makes them, and says so", () => {
    const d = leftovers();
    const said: string[] = [];
    expect(sweepScratch(d, { keep: false, say: l => said.push(l) })).toEqual(["morndo-c2-build-AbC123"]);
    expect(readdirSync(d).sort()).toEqual(["morndo-c2-build-XyZ789", "morndo-c2-build-ab12", "morndo-c2-build-notours-1", "someone-elses"]);
    expect(said).toEqual(["removed the build scratch a killed run left behind (morndo-c2-build-AbC123)"]);
  });

  it("keeps everything when the scratch is kept (E2E_KEEP=1)", () => {
    const d = leftovers();
    const before = readdirSync(d).sort();
    expect(sweepScratch(d, { keep: true, say: () => {} })).toEqual([]);
    expect(readdirSync(d).sort()).toEqual(before);
  });
});

describe("nextMigration", () => {
  it("is one past the highest number in the file, wherever it stands", () => {
    const text = ["  {", "    version: 24,", "  },", "  {", "    version: 25,", "  },", "  {", "    version: 3,", "  },"].join("\n");
    expect(nextMigration(text)).toBe(26);
    expect(() => nextMigration("export const MIGRATIONS = [];")).toThrow(/no migration numbers/);
  });
});

describe("recoverUnitRan", () => {
  const started = "Starting morndo-update-recover.service - Recover a half-applied Morndo update...";
  const finished = "Finished morndo-update-recover.service - Recover a half-applied Morndo update.";
  it("needs the unit to have started and finished, and nothing that says it failed", () => {
    expect(recoverUnitRan(`${started}\n${finished}\n`)).toBe(true);
    expect(recoverUnitRan("")).toBe(false);                                  // never ran: the old check passed this
    expect(recoverUnitRan(`${started}\n`)).toBe(false);
    expect(recoverUnitRan(`${started}\nmorndo-update-recover.service: Main process exited, code=exited, status=70/SOFTWARE\n${finished}\n`)).toBe(false);
    expect(recoverUnitRan(`${started}\nmorndo-update-recover.service: Failed with result 'exit-code'.\n`)).toBe(false);
  });
});

describe("saysDiskFull", () => {
  it("takes the hub's backup refused for a full disk, and no other refusal", () => {
    expect(saysDiskFull("Not applied: hub: the backup did not pass its check (hub: database or disk is full). The old Version runs.")).toBe(true);
    expect(saysDiskFull("Not applied: hub: the backup did not pass its check (hub: ENOSPC: no space left on device)")).toBe(true);
    expect(saysDiskFull("Not applied: hub: the backup did not pass its check (hub: quick_check answered \"corrupt\")")).toBe(false);
    expect(saysDiskFull("Not applied: the staged manifest changed since it was recorded. The old Version runs.")).toBe(false);
  });
});
