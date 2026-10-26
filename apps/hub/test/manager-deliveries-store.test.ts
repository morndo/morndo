// Migration 16 (fleet-clients §9.1, plan.md Databases; 13 to 15 are the board, Home's usage and #29's pending_answers,
// which stays, unused): manager_deliveries, one row per delivery of an answer or a message to the manager, so a hub
// restart keeps following it; never the text. And the decisions row of a queued answer, changed or dropped only while it
// is still the Decision that was queued (a newer answer's row is left alone; #29's code review B3). Real SQLite files in
// a temp dir.
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "../src/adapters/migrations.ts";
import { Store, type ManagerDeliveryRow } from "../src/adapters/store.ts";

const T0 = Date.UTC(2026, 9, 8, 9);
let dir: string;
let store: Store;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-mgr-deliveries-")); store = new Store(dir); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const row = (o: Partial<ManagerDeliveryRow> = {}): ManagerDeliveryRow => ({
  deliveryId: "hub:answer:ny-7:m1:option:ship", kind: "answer", escalationId: "ny-7", ask: "m1",
  choice: JSON.stringify({ kind: "option", key: "ship", label: "Ship it" }), endpointId: "ep1", sessionId: "s1", requestId: "r1",
  queuedAt: T0, state: "sending", updatedAt: T0, ...o,
});

describe("migration 18", () => {
  it("gives a database at 17 (the jobs' notices) manager_deliveries, keeps its rows, and changes nothing run again", () => {
    const db = new Database(join(dir, "other.db"));
    migrate(db, MIGRATIONS.slice(0, 17));
    db.prepare("INSERT INTO decisions (escalation_id, at, body) VALUES ('ny-7', 5, '{}')").run();
    expect(migrate(db, MIGRATIONS.slice(0, 18))).toEqual({ from: 17, to: 18 });
    const cols = (db.prepare("PRAGMA table_info(manager_deliveries)").all() as { name: string }[]).map(c => c.name);
    expect(cols).toEqual(["delivery_id", "kind", "escalation_id", "ask", "choice", "endpoint_id", "session_id", "request_id", "queued_at", "state", "updated_at"]);
    expect(db.prepare("SELECT escalation_id FROM decisions").all()).toEqual([{ escalation_id: "ny-7" }]);
    expect(() => MIGRATIONS[17]?.up(db)).not.toThrow();
    db.close();
  });
  it("refuses a state or a kind it doesn't know (negative control)", () => {
    expect(() => store.saveManagerDelivery(row({ state: "teleported" as never }))).toThrow(/CHECK/);
    expect(() => store.saveManagerDelivery(row({ kind: "note" as never }))).toThrow(/CHECK/);
  });
});

describe("the manager's deliveries", () => {
  it("a row is written once, read back whole, and moves through its states", () => {
    store.saveManagerDelivery(row());
    store.saveManagerDelivery(row({ state: "queued" }));                        // a second write of the same id changes nothing
    expect(store.managerDelivery("hub:answer:ny-7:m1:option:ship")).toEqual(row());
    store.setManagerDeliveryState("hub:answer:ny-7:m1:option:ship", "typed", T0 + 5);
    expect(store.managerDelivery("hub:answer:ny-7:m1:option:ship")).toMatchObject({ state: "typed", updatedAt: T0 + 5 });
    expect(store.openManagerDeliveries().map(r => r.deliveryId)).toEqual(["hub:answer:ny-7:m1:option:ship"]);
    store.setManagerDeliveryState("hub:answer:ny-7:m1:option:ship", "delivered", T0 + 9);
    expect(store.openManagerDeliveries()).toEqual([]);
  });
  it("finds a request's row, an answer's row by its Decision, and a key's attempts in order", () => {
    store.saveManagerDelivery(row({ state: "given_up" }));
    store.saveManagerDelivery(row({ deliveryId: "hub:answer:ny-7:m1:option:ship~2", requestId: "r2", queuedAt: T0 + 10, state: "queued" }));
    store.saveManagerDelivery(row({ deliveryId: "hub:answer:ny-7:m1:option:shipping", requestId: "r3", queuedAt: T0 + 20 }));
    store.saveManagerDelivery(row({ deliveryId: "hub:ep1:r9", kind: "command", escalationId: null, ask: null, choice: null, requestId: "r9", queuedAt: T0 + 30 }));
    expect(store.managerDeliveryOfRequest("ep1", "r2")?.deliveryId).toBe("hub:answer:ny-7:m1:option:ship~2");
    expect(store.managerDeliveryOfRequest("ep2", "r2")).toBeNull();
    expect(store.answerDelivery("ny-7", T0 + 10)?.deliveryId).toBe("hub:answer:ny-7:m1:option:ship~2");
    expect(store.managerDeliveryAttempts("hub:answer:ny-7:m1:option:ship").map(r => r.deliveryId))
      .toEqual(["hub:answer:ny-7:m1:option:ship", "hub:answer:ny-7:m1:option:ship~2"]);   // never another key that starts so
    expect(store.managerDeliveriesWithPrefix("hub:answer:ny-7:m1:").map(r => r.deliveryId)).toHaveLength(3);
    expect(store.commandDeliveriesOf("ep1", T0).map(r => r.deliveryId)).toEqual(["hub:ep1:r9"]);
  });
  it("prunes what changed before a time; drops one row", () => {
    store.saveManagerDelivery(row({ state: "delivered", updatedAt: T0 }));
    store.saveManagerDelivery(row({ deliveryId: "hub:ep1:r9", kind: "command", requestId: "r9", updatedAt: T0 + 100 }));
    expect(store.pruneManagerDeliveries(T0 + 50)).toBe(1);
    store.dropManagerDelivery("hub:ep1:r9");
    expect(store.openManagerDeliveries()).toEqual([]);
  });
});

describe("a queued answer's decisions row", () => {
  it("is replaced or dropped only while it is the Decision taken at that time", () => {
    store.saveDecision("ny-7", { at: T0, choice: { kind: "words" } });
    store.replaceDecisionIf("ny-7", T0 + 1, { at: T0 + 1, replaced: true });          // another answer's time: untouched
    store.dropDecisionIf("ny-7", T0 + 1);
    expect(store.decisions()).toEqual([{ id: "ny-7", decision: { at: T0, choice: { kind: "words" } } }]);
    store.replaceDecisionIf("ny-7", T0, { at: T0, choice: { kind: "words" }, delivery: { state: "delivered", at: T0 + 5 } });
    expect(store.decisions()[0]?.decision).toMatchObject({ delivery: { state: "delivered", at: T0 + 5 } });
    store.dropDecisionIf("ny-7", T0);
    expect(store.decisions()).toEqual([]);
  });
});
