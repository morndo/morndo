// The lane registry (spec 4): the first registrant keeps a name; a duplicate name from another node or window puts it
// in conflict for both and blocks routing by it (a conflict event { name, nodes }, then a lane_conflict alert); a
// node's claims survive it going offline and a restart; window names with spaces, unicode, dots and slashes survive
// exactly (Review Focus 1).
import type Database from "better-sqlite3";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Pane } from "@morndo/protocol";
import { Audit } from "../src/adapters/audit.ts";
import { openFleetDb } from "../src/adapters/db.ts";
import { LanesStore } from "../src/adapters/lanes-store.ts";
import { EventHub, type FleetEvent } from "../src/application/events.ts";
import { LaneRegistry } from "../src/application/lane-registry.ts";
import { ODD_NAMES } from "./helpers/odd-names.ts";
import { tempDir } from "./helpers/temp.ts";

const pane = (node: string, n: number, window: string): Pane => ({ workerId: `${node}.3fa2c1d0.${n}`, window, cwd: `/work/${n}` });

function setup(db: Database.Database = openFleetDb(join(tempDir(), "fleet.db")), active = ["pc", "mac"]) {
  const events = new EventHub();
  const seen: FleetEvent[] = [];
  events.subscribe(e => seen.push(e));
  const audit = new Audit(db, { onAlert: a => events.emit({ t: "alert", node: a.node ?? "", body: a }) });   // as serve.ts wires it
  return { db, audit, seen, lanes: new LaneRegistry({ store: new LanesStore(db), events, audit, activeNodes: active }) };
}

describe("the lane registry", () => {
  it("registers each window name to its node and worker", () => {
    const { lanes } = setup();
    lanes.inventory("pc", [pane("pc", 1, "api"), pane("pc", 2, "web")]);
    expect(lanes.list()).toEqual([
      { name: "api", node: "pc", workerId: "pc.3fa2c1d0.1", conflict: false },
      { name: "web", node: "pc", workerId: "pc.3fa2c1d0.2", conflict: false },
    ]);
    expect(lanes.resolve("api")).toEqual({ kind: "ok", node: "pc", workerId: "pc.3fa2c1d0.1" });
    expect(lanes.resolve("nope")).toEqual({ kind: "none" });
  });

  it("the first registrant keeps a name; a second node claiming it puts it in conflict and blocks routing", () => {
    const { lanes, seen, audit } = setup();
    lanes.inventory("pc", [pane("pc", 1, "api")]);
    lanes.inventory("mac", [pane("mac", 7, "api")]);
    expect(lanes.list()).toEqual([{ name: "api", node: "pc", workerId: "pc.3fa2c1d0.1", conflict: true }]);
    expect(lanes.resolve("api")).toEqual({ kind: "conflict", claims: [{ node: "pc", workerId: "pc.3fa2c1d0.1" }, { node: "mac", workerId: "mac.3fa2c1d0.7" }] });
    expect(seen.filter(e => e.t === "conflict" || e.t === "alert")).toEqual([
      { t: "conflict", node: "pc", body: { name: "api", nodes: ["pc", "mac"] } },
      { t: "alert", node: "pc", body: expect.objectContaining({ kind: "lane_conflict", detail: { name: "api", claims: [{ node: "pc", workerId: "pc.3fa2c1d0.1" }, { node: "mac", workerId: "mac.3fa2c1d0.7" }] } }) },
    ]);
    expect(audit.of("alert.lane_conflict")).toHaveLength(1);
    lanes.inventory("mac", [pane("mac", 7, "api-2")]);                               // the owner renamed one window
    expect(lanes.resolve("api")).toEqual({ kind: "ok", node: "pc", workerId: "pc.3fa2c1d0.1" });
    expect(lanes.resolve("api-2")).toEqual({ kind: "ok", node: "mac", workerId: "mac.3fa2c1d0.7" });
    expect(seen.filter(e => e.t === "conflict").map(e => e.body)).toEqual([{ name: "api", nodes: ["pc", "mac"] }, { name: "api", nodes: [] }]);
  });

  it("two windows of one name on one node are a conflict too", () => {
    const { lanes, seen } = setup();
    lanes.inventory("pc", [pane("pc", 1, "api"), pane("pc", 2, "api")]);
    expect(lanes.list()).toEqual([{ name: "api", node: "pc", workerId: null, conflict: true }]);
    expect(lanes.resolve("api").kind).toBe("conflict");
    expect(seen.filter(e => e.t === "conflict").map(e => e.body)).toEqual([{ name: "api", nodes: ["pc"] }]);
  });

  it("when the owner lets a name go, the earliest other claimant takes it", () => {
    const { lanes } = setup();
    lanes.inventory("pc", [pane("pc", 1, "api")]);
    lanes.inventory("mac", [pane("mac", 7, "api")]);
    lanes.inventory("pc", []);
    expect(lanes.list()).toEqual([{ name: "api", node: "mac", workerId: "mac.3fa2c1d0.7", conflict: false }]);
    lanes.inventory("mac", []);
    expect(lanes.list()).toEqual([]);
  });

  it("a node's worker ID for a name follows its inventory (a restarted tmux server stamps new IDs)", () => {
    const { lanes } = setup();
    lanes.inventory("pc", [pane("pc", 1, "api")]);
    lanes.inventory("pc", [{ workerId: "pc.0badcafe.0", window: "api", cwd: "/work" }]);
    expect(lanes.resolve("api")).toEqual({ kind: "ok", node: "pc", workerId: "pc.0badcafe.0" });
  });

  it("keeps names with spaces, unicode, dots and slashes exactly, and resolves each to its worker", () => {
    const { lanes } = setup();
    lanes.inventory("pc", ODD_NAMES.map((name, i) => pane("pc", i, name)));
    expect(lanes.list().map(l => l.name).sort()).toEqual([...ODD_NAMES].sort());
    ODD_NAMES.forEach((name, i) => expect(lanes.resolve(name)).toEqual({ kind: "ok", node: "pc", workerId: `pc.3fa2c1d0.${i}` }));
    expect(lanes.resolve("fix: a")).toEqual({ kind: "none" });                       // never split on a separator
    expect(lanes.resolve("fix: a/b ü")).toEqual({ kind: "none" });
  });

  it("after a restart a persisted owner keeps its name until it reports: another node's claim is a conflict, not a takeover", () => {
    const first = setup();
    first.lanes.inventory("pc", [pane("pc", 1, "api")]);
    const after = setup(first.db);
    after.lanes.inventory("mac", [pane("mac", 7, "api")]);
    expect(after.lanes.list()).toEqual([{ name: "api", node: "pc", workerId: "pc.3fa2c1d0.1", conflict: true }]);
    after.lanes.inventory("pc", [pane("pc", 1, "web")]);
    expect(after.lanes.resolve("api")).toEqual({ kind: "ok", node: "mac", workerId: "mac.3fa2c1d0.7" });
  });

  it("revoking a node drops its lanes, clears the conflict, and hands its names to the other claimant", () => {
    const { lanes, seen } = setup();
    lanes.inventory("pc", [pane("pc", 1, "api"), pane("pc", 2, "solo")]);
    lanes.inventory("mac", [pane("mac", 7, "api")]);
    lanes.dropNode("pc");
    expect(lanes.list()).toEqual([{ name: "api", node: "mac", workerId: "mac.3fa2c1d0.7", conflict: false }]);
    expect(seen.filter(e => e.t === "conflict").map(e => e.body)).toEqual([{ name: "api", nodes: ["pc", "mac"] }, { name: "api", nodes: [] }]);
  });

  it("drops the lanes of nodes that are no longer registered when it starts", () => {
    const first = setup();
    first.lanes.inventory("pc", [pane("pc", 1, "api")]);
    first.lanes.inventory("old", [pane("old", 1, "legacy")]);
    const after = setup(first.db, ["pc"]);
    expect(after.lanes.list().map(l => l.name)).toEqual(["api"]);
  });
});
