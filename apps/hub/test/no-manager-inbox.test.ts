// The fleet's delivery queue is the only queue for the manager's answers and messages (fleet-clients §9.1; plan
// reconciliation ruling 81). PR #29's manager inbox (kira's spool, MORNDO_MANAGER_INBOX) is gone from the hub: no adapter
// writes the spool, and no setting turns it on, so nothing the hub does can type into the manager a second way. ADR-0010,
// which put it there, says it is superseded, and keeps its status as it was.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

const SRC = join(import.meta.dirname, "../src");
const ADR_0010 = join(import.meta.dirname, "../../../docs/adr/0010-manager-inbox.md");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
// What only a writer of the spool names: its setting, its adapter, and the files of its on-disk contract.
const SPOOL = /MORNDO_MANAGER_INBOX|manager-inbox\.ts|deliverer\.json|ctl\/\$\{|"msg"|kira\/inbox/;

describe("the manager's inbox is gone from the hub (ruling 81)", () => {
  it("no hub source writes kira's spool or reads its setting", () => {
    expect(existsSync(join(SRC, "adapters/manager-inbox.ts"))).toBe(false);
    const found = files(SRC).flatMap(f => readFileSync(f, "utf8").split("\n").flatMap((l, i) => (SPOOL.test(l) ? [`${relative(SRC, f)}:${i + 1}: ${l.trim()}`] : [])));
    expect(found).toEqual([]);
  });

  it("MORNDO_MANAGER_INBOX set is ignored: the settings have no inbox", () => {
    const config = loadConfig({ MORNDO_ORIGIN: "https://hub.example.test", MORNDO_HOME: "/tmp/morndo-unused", MORNDO_MANAGER_INBOX: "/home/x/kira/inbox" });
    expect(Object.keys(config).filter(k => /inbox/i.test(k) && k !== "inboxDir")).toEqual([]);
    expect(JSON.stringify(config)).not.toContain("kira");
  });

  it("ADR-0010 says it is superseded by ADR-0014, under its status as it was", () => {
    const adr = readFileSync(ADR_0010, "utf8");
    expect(adr).toMatch(/^- \*\*Status:\*\* Accepted, 2026-10-04\. /m);
    expect(adr).toContain("- **Superseded** by ADR-0014 (fleet clients, §9.1): the manager's answers and messages go through the fleet's delivery queue.");
  });
});
