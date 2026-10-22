// The revocation journal (RL10, docs/design/updates/README.md §11.5): a service appends every revocation to
// revoked.log beside its database before it writes the database, and reads the journal back at start. A torn last
// line is a crash mid-write and is skipped; any other line that is not a whole entry is skipped and reported, never
// thrown, so one bad line neither hides the rest nor stops a service from starting.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RevocationJournal } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const dir = () => { const d = mkdtempSync(join(tmpdir(), "morndo-journal-")); dirs.push(d); return d; };

const node = (id: string, at = 1, enrolment = `en-${id}`) => JSON.stringify({ kind: "node", id, enrolment, at });
const nodeEntry = (id: string, at = 1, enrolment = `en-${id}`) => ({ kind: "node" as const, id, enrolment, at });

describe("RevocationJournal", () => {
  it("appends one line an entry each, and reads them back in order", () => {
    const path = join(dir(), "revoked.log");
    const journal = new RevocationJournal(path);
    journal.append({ kind: "endpoint", id: "eph-1", at: 5 });
    journal.append({ kind: "agent_token", id: "mat-1", at: 6 });
    journal.append(nodeEntry("pc", 7));
    expect(journal.entries()).toEqual([
      { kind: "endpoint", id: "eph-1", at: 5 }, { kind: "agent_token", id: "mat-1", at: 6 }, nodeEntry("pc", 7),
    ]);
    expect(readFileSync(path, "utf8")).toBe(`{"kind":"endpoint","id":"eph-1","at":5}\n{"kind":"agent_token","id":"mat-1","at":6}\n${node("pc", 7)}\n`);
  });

  it("creates the file with mode 0600", () => {
    const path = join(dir(), "revoked.log");
    new RevocationJournal(path).append(nodeEntry("pc"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("reads an absent journal as empty", () => {
    expect(new RevocationJournal(join(dir(), "revoked.log")).read()).toEqual({ entries: [], bad: [] });
  });

  it("skips a torn last line, a crash mid-write, without calling it bad", () => {
    const path = join(dir(), "revoked.log");
    const journal = new RevocationJournal(path);
    journal.append(nodeEntry("pc"));
    appendFileSync(path, '{"kind":"node","id":"torn');         // no newline: the write never finished
    expect(journal.read()).toEqual({ entries: [nodeEntry("pc")], bad: [] });
  });

  it("an append after a torn last line cuts the torn bytes first, so the journal still reads", () => {
    // The crash left a line without its newline; the next revocation must not glue onto it, or every later start
    // would find a whole bad line where two entries should be.
    const path = join(dir(), "revoked.log");
    const journal = new RevocationJournal(path);
    journal.append(nodeEntry("pc"));
    appendFileSync(path, '{"kind":"node","id":"torn');
    journal.append(nodeEntry("laptop", 2));
    expect(journal.read()).toEqual({ entries: [nodeEntry("pc"), nodeEntry("laptop", 2)], bad: [] });
    expect(readFileSync(path, "utf8")).toBe(`${node("pc")}\n${node("laptop", 2)}\n`);
    // a file that is nothing but a torn line is cut to nothing first
    const only = join(dir(), "revoked.log");
    writeFileSync(only, '{"kind":"no');
    new RevocationJournal(only).append(nodeEntry("pc"));
    expect(readFileSync(only, "utf8")).toBe(`${node("pc")}\n`);
  });

  it("skips and reports every bad line that is not the torn last one, and keeps the rest", () => {
    const path = join(dir(), "revoked.log");
    writeFileSync(path, [
      node("pc", 1), "not json at all", '{"kind":"device","id":"x","at":1}', '{"kind":"node","id":"old","at":1}', "",
      node("mac", 2),
    ].join("\n") + "\n" + '{"kind":"node","id":"to');            // and a torn last line after them
    const read = new RevocationJournal(path).read();
    expect(read.entries).toEqual([nodeEntry("pc", 1), nodeEntry("mac", 2)]);
    expect(read.bad.map(b => b.line)).toEqual([2, 3, 4, 5]);
    expect(read.bad[2]!.why).toMatch(/without its enrolment/);   // a node line must name what it revoked
  });

  it("two journal objects on one file both land, as two processes", () => {
    const path = join(dir(), "revoked.log");
    new RevocationJournal(path).append(nodeEntry("pc", 1));
    new RevocationJournal(path).append(nodeEntry("mac", 2));
    expect(new RevocationJournal(path).entries()).toEqual([nodeEntry("pc", 1), nodeEntry("mac", 2)]);
  });

  it("compacts past its size to one entry per thing revoked, the latest, and leaves a small one alone", () => {
    const path = join(dir(), "revoked.log");
    const journal = new RevocationJournal(path);
    journal.append(nodeEntry("pc", 1, "en-1"));
    journal.append({ kind: "endpoint", id: "eph-1", at: 2 });
    journal.append(nodeEntry("pc", 3, "en-1"));                  // a start that re-applied it wrote it again
    journal.append(nodeEntry("pc", 4, "en-2"));                  // a later enrolment under the same name
    appendFileSync(path, "garbage\n");
    const before = readFileSync(path, "utf8");
    expect(journal.compact(before.length)).toBe(false);          // not past the size: untouched
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(journal.compact(10)).toBe(true);
    expect(journal.read()).toEqual({
      entries: [nodeEntry("pc", 3, "en-1"), { kind: "endpoint", id: "eph-1", at: 2 }, nodeEntry("pc", 4, "en-2")], bad: [],
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(new RevocationJournal(join(dir(), "absent.log")).compact(0)).toBe(false);
  });
  it("an append from another process while compaction rewrites waits for it and is kept", async () => {
    // The other process's append arrives after compaction read the journal and before it renames the rewrite in:
    // without one lock over both, the rename would drop it.
    const path = join(dir(), "revoked.log");
    const journal = new RevocationJournal(path);
    journal.append(nodeEntry("pc", 1));
    journal.append(nodeEntry("pc", 2));
    const source = new URL("../src/revocation-journal.ts", import.meta.url).pathname;
    let child: ReturnType<typeof spawn> | null = null;
    journal.compact(10, {
      beforeRename: () => {
        child = spawn(process.execPath, ["--input-type=module", "-e",
          `import { RevocationJournal } from ${JSON.stringify(source)}; new RevocationJournal(${JSON.stringify(path)}).append(${JSON.stringify(nodeEntry("mac", 3))});`],
          { stdio: "ignore" });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);   // time enough for it to land, unlocked
      },
    });
    const code = await new Promise<number | null>(resolve => { child!.on("exit", c => resolve(c)); });
    expect(code).toBe(0);
    expect(journal.entries()).toEqual([nodeEntry("pc", 2), nodeEntry("mac", 3)]);
  });
});
