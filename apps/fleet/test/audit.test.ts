// Alerts (Contracts, "Alerts"): an audit row whose action is alert.<kind>, plus a log warning; served as an Alert (id:
// the row's seq; kind: the action without "alert."), the latest 500 of the security kinds and the latest 500 of the
// others, oldest first; and handed to the listener as raised. Audit rows go after 90 days.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS, type Alert } from "@morndo/protocol";
import { Audit } from "../src/adapters/audit.ts";
import { openFleetDb } from "../src/adapters/db.ts";
import { createLogger } from "../src/adapters/log.ts";
import { tempDir } from "./helpers/temp.ts";

describe("alerts", () => {
  it("are audit rows, served as Alerts (the latest 500 of each class, oldest first) and handed to the listener as they are raised", () => {
    let now = 1_800_000_000_000;
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const heard: Alert[] = [];
    const warned: string[] = [];
    const audit = new Audit(db, { now: () => now, log: createLogger({ level: "warn", sink: line => warned.push(line) }), onAlert: a => heard.push(a) });
    audit.record("cli", "node.add", "pc", { expiresAt: 1 });                           // not an alert
    const first = audit.alert("clock_offset", "pc", { offsetMs: 10_000 });
    expect(first).toEqual({ id: 2, at: now, node: "pc", kind: "clock_offset", detail: { offsetMs: 10_000 } });
    expect(audit.of("alert.clock_offset").map(e => [e.actor, e.node, e.detail])).toEqual([["fleet", "pc", { offsetMs: 10_000 }]]);
    expect(warned).toEqual(["[fleet] warn: alert: clock_offset on node pc"]);
    expect(audit.recentAlerts()).toEqual([first]);
    for (let i = 0; i < 501; i++) { now++; audit.alert("dead_letter", null, { seq: i }); }
    const served = audit.recentAlerts();
    expect(served).toHaveLength(501);
    // The security alert stays, though 501 others came after it; of the others, the oldest went.
    expect(served[0]).toEqual(first);
    expect(served[1]).toEqual({ id: 4, at: 1_800_000_000_002, node: null, kind: "dead_letter", detail: { seq: 1 } });
    expect(served.at(-1)).toMatchObject({ id: 503, detail: { seq: 500 } });
    expect(heard).toHaveLength(502);
    expect(heard.at(-1)).toEqual(served.at(-1));
    db.close();
  });

  it("no number of other alerts pushes a security alert out; each class keeps its own latest 500", () => {
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const audit = new Audit(db);
    const security = [audit.alert("instance_conflict", "pc", {}), audit.alert("source_changed", "pc", {}), audit.alert("clock_offset", "pc", {})];
    for (let i = 0; i < 1200; i++) audit.alert(i % 2 ? "lane_conflict" : "dead_letter", "pc", { i });
    const served = audit.recentAlerts();
    expect(served.slice(0, 3)).toEqual(security);                                    // negative control: one shared cap of 500 drops all three
    expect(served).toHaveLength(503);
    expect(served.map(a => a.id)).toEqual([...served.map(a => a.id)].sort((a, b) => a - b));   // oldest first, merged
    for (let i = 0; i < 600; i++) audit.alert("clock_offset", "pc", { i });
    expect(audit.recentAlerts().filter(a => a.kind === "clock_offset" || a.kind === "instance_conflict" || a.kind === "source_changed")).toHaveLength(500);
    db.close();
  });
});

describe("retention", () => {
  it("prune() deletes audit rows older than 90 days, alerts included, and keeps the rest", () => {
    let now = 1_800_000_000_000;
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const audit = new Audit(db, { now: () => now });
    audit.record("cli", "node.add", "pc");
    audit.alert("instance_conflict", "pc", {});
    now += LIMITS.auditKeepMs - 1;
    audit.record("cli", "node.revoke", "pc");
    expect(audit.prune()).toBe(0);                                                   // 90 days less a millisecond: kept
    now += 2;
    expect(audit.prune()).toBe(2);
    expect(audit.recent().map(e => e.action)).toEqual(["node.revoke"]);
    expect(audit.recentAlerts()).toEqual([]);
    db.close();
  });
});
