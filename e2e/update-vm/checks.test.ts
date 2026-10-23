// The throwaway-machine run's own judgements (checks.ts), tested without a machine: whose run a leftover is (a fake
// /proc), the two sweeps that remove only what a gone run left, the scratch migration's number, and the two log
// readings the scenario's checks rest on.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeOwnedScratch, nextMigration, ownerAlive, ownerOf, ownerText, parseOwner, recoverUnitRan, saysDiskFull, SCRATCH_NAME, sweepContainers, sweepScratch } from "./checks.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const dir = () => { const d = mkdtempSync(join(tmpdir(), "morndo-e2e-checks-")); dirs.push(d); return d; };

// A fake /proc: each live process's stat line, its start time in field 22 (proc(5)).
const fakeProc = (live: Record<number, string>) => {
  const root = dir();
  for (const [pid, started] of Object.entries(live)) {
    mkdirSync(join(root, pid));
    const fields = ["S", "1", "1", "1", "0", "-1", "4194560", "0", "0", "0", "0", "0", "0", "0", "0", "20", "0", "1", "0", started, "1000", "100"];
    writeFileSync(join(root, pid, "stat"), `${pid} (node) ${fields.join(" ")}\n`);
  }
  return root;
};

describe("the owner of a run", () => {
  it("is its pid and start time; alive only while that very process runs (a reused pid is not it)", () => {
    const proc = fakeProc({ 4242: "777" });
    const owner = ownerOf(4242, proc);
    expect(owner).toEqual({ pid: 4242, started: "777" });
    expect(parseOwner(ownerText(owner))).toEqual(owner);
    expect(ownerAlive(owner, proc)).toBe(true);
    expect(ownerAlive({ pid: 4242, started: "778" }, proc)).toBe(false);   // the pid came back for another process
    expect(ownerAlive({ pid: 4343, started: "777" }, proc)).toBe(false);   // gone
    expect(parseOwner("")).toBeNull();
    expect(parseOwner("not-an-owner")).toBeNull();
  });
});

// A temp directory as runs leave it: scratch of a live run, of a gone one, of a reused pid, and one without an owner
// (a run from before owners: a build dir now never exists without one, makeOwnedScratch below); a file of the same
// shape, names that only look alike.
const leftovers = () => {
  const d = dir();
  const scratch = (name: string, owner: string | null) => {
    mkdirSync(join(d, name));
    writeFileSync(join(d, name, "x"), "a copy of the repository");
    if (owner !== null) writeFileSync(join(d, name, "owner"), owner);
  };
  scratch("morndo-c2-build-Live01", "4242:777");
  scratch("morndo-c2-build-Gone01", "5151:900");
  scratch("morndo-c2-build-Reus01", "4242:111");
  scratch("morndo-c2-build-Olde01", null);
  writeFileSync(join(d, "morndo-c2-build-XyZ789"), "a file, not a scratch directory");
  mkdirSync(join(d, "morndo-c2-build-notours-1"));
  mkdirSync(join(d, "someone-elses"));
  return d;
};

describe("sweepScratch", () => {
  it("removes only scratch whose run is gone, never a live run's, and only real directories named as the build makes them", () => {
    const proc = fakeProc({ 4242: "777" });
    const d = leftovers();
    const said: string[] = [];
    expect(sweepScratch(d, { keep: false, say: l => said.push(l), procRoot: proc }).sort())
      .toEqual(["morndo-c2-build-Gone01", "morndo-c2-build-Olde01", "morndo-c2-build-Reus01"]);
    expect(readdirSync(d).sort()).toEqual(["morndo-c2-build-Live01", "morndo-c2-build-XyZ789", "morndo-c2-build-notours-1", "someone-elses"]);
    expect(said).toHaveLength(3);
  });

  it("keeps everything when the scratch is kept (E2E_KEEP=1)", () => {
    const proc = fakeProc({});
    const d = leftovers();
    const before = readdirSync(d).sort();
    expect(sweepScratch(d, { keep: true, say: () => {}, procRoot: proc })).toEqual([]);
    expect(readdirSync(d).sort()).toEqual(before);
  });
});

describe("an owner whose /proc entry cannot be read", () => {
  it("is not taken for gone: only a stat that is not there (ENOENT) is; any other failure keeps the leftover", () => {
    const proc = fakeProc({ 4242: "777" });
    chmodSync(join(proc, "4242", "stat"), 0o000);                  // hidepid, another namespace: there, not readable
    try {
      expect(ownerAlive({ pid: 4242, started: "777" }, proc)).toBe(true);
      const removed: string[] = [];
      sweepContainers({ list: () => [{ id: "aaa", owner: "4242:777" }], remove: id => { removed.push(id); return { ok: true, err: "" }; }, say: () => {}, procRoot: proc });
      expect(removed).toEqual([]);
    } finally { chmodSync(join(proc, "4242", "stat"), 0o644); }
    writeFileSync(join(proc, "4242", "stat"), "4242 (node) S 1\n");      // a stat it cannot parse: unknown, kept too
    expect(ownerAlive({ pid: 4242, started: "777" }, proc)).toBe(true);
    expect(ownerAlive({ pid: 4343, started: "777" }, proc)).toBe(false);   // ENOENT: gone
  });
});

describe("makeOwnedScratch", () => {
  it("has no moment under the build's name without its owner: a sweep right after the create sees nothing to take", () => {
    const d = dir();
    const proc = fakeProc({});                                       // the creating run looks gone to the sweep
    const made = makeOwnedScratch(d, "4242:777", {
      afterCreate: () => { expect(sweepScratch(d, { keep: false, say: () => {}, procRoot: proc })).toEqual([]); },
    });
    expect(SCRATCH_NAME.test(made.split("/").pop()!)).toBe(true);
    expect(readFileSync(join(made, "owner"), "utf8")).toBe("4242:777");
    expect(readdirSync(d)).toEqual([made.split("/").pop()]);           // the transient name is gone
    expect(existsSync(made)).toBe(true);
  });
});

describe("sweepContainers", () => {
  it("removes only labelled containers whose run is gone (or that carry no owner), never a live run's", () => {
    const proc = fakeProc({ 4242: "777" });
    const removed: string[] = [];
    const said: string[] = [];
    const out = sweepContainers({
      list: () => [
        { id: "aaa", owner: "4242:777" },    // a run going on now
        { id: "bbb", owner: "5151:900" },    // its run was killed
        { id: "ccc", owner: "" },            // from before owners were labelled
        { id: "ddd", owner: "4242:111" },    // the pid is another process now
      ],
      remove: id => { removed.push(id); return { ok: true, err: "" }; },
      say: l => said.push(l), procRoot: proc,
    });
    expect(out).toEqual(["bbb", "ccc", "ddd"]);
    expect(removed).toEqual(["bbb", "ccc", "ddd"]);
    expect(said).toHaveLength(3);
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
