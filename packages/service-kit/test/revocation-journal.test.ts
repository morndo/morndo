// The revocation journal (RL10, docs/design/updates/README.md §11.5): a service appends every revocation to
// revoked.log beside its database before it writes the database, and reads the journal back at start. A torn last
// line is a crash mid-write and is skipped; anything else that is not a whole entry is refused loudly, because a
// revocation lost in silence is exactly what the journal exists to prevent.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JournalUnreadable, RevocationJournal } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const dir = () => { const d = mkdtempSync(join(tmpdir(), "morndo-journal-")); dirs.push(d); return d; };

const node = (id: string, at = 1) => JSON.stringify({ kind: "node", id, at });

describe("RevocationJournal", () => {
  it("appends one line an entry each, and reads them back in order", () => {
    const path = join(dir(), "revoked.log");
    const journal = new RevocationJournal(path);
    journal.append({ kind: "endpoint", id: "eph-1", at: 5 });
    journal.append({ kind: "agent_token", id: "mat-1", at: 6 });
    expect(journal.entries()).toEqual([
      { kind: "endpoint", id: "eph-1", at: 5 }, { kind: "agent_token", id: "mat-1", at: 6 },
    ]);
    expect(readFileSync(path, "utf8")).toBe('{"kind":"endpoint","id":"eph-1","at":5}\n{"kind":"agent_token","id":"mat-1","at":6}\n');
  });

  it("creates the file with mode 0600", () => {
    const path = join(dir(), "revoked.log");
    new RevocationJournal(path).append({ kind: "node", id: "pc", at: 1 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("reads an absent journal as empty", () => {
    expect(new RevocationJournal(join(dir(), "revoked.log")).entries()).toEqual([]);
  });

  it("skips a torn last line, a crash mid-write", () => {
    const path = join(dir(), "revoked.log");
    const journal = new RevocationJournal(path);
    journal.append({ kind: "node", id: "pc", at: 1 });
    appendFileSync(path, '{"kind":"node","id":"torn');         // no newline: the write never finished
    expect(journal.entries()).toEqual([{ kind: "node", id: "pc", at: 1 }]);
  });

  it("refuses a bad line that is not the torn last one, naming the line", () => {
    const path = join(dir(), "revoked.log");
    writeFileSync(path, `${node("pc", 1)}\nnot json at all\n${node("mac", 2)}\n`);
    const read = () => new RevocationJournal(path).entries();
    expect(read).toThrow(JournalUnreadable);
    expect(read).toThrow("line 2");
    writeFileSync(path, `${node("pc", 1)}\n{"kind":"device","id":"x","at":1}\n`);   // a kind no service writes
    expect(read).toThrow("line 2");
    writeFileSync(path, node("pc", 1) + "\n\n");                 // an empty line is not an entry either
    expect(read).toThrow("line 2");
  });

  it("two journal objects on one file both land, as two processes", () => {
    const path = join(dir(), "revoked.log");
    const console_ = new RevocationJournal(path);
    const service = new RevocationJournal(path);
    console_.append({ kind: "node", id: "pc", at: 1 });
    service.append({ kind: "node", id: "mac", at: 2 });
    expect(new RevocationJournal(path).entries()).toEqual([
      { kind: "node", id: "pc", at: 1 }, { kind: "node", id: "mac", at: 2 },
    ]);
  });
});
