// The Secrets service over the real SQLite store (criteria 11 and 12 end to end): the fake sealed store and index stand in
// for the vault, so this proves the store's transaction and the ledger, not the files. Values are synthetic.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Actor, SecretGrant } from "@morndo/domain";
import { CountingIds, ManualClock, MemoryIndex, MemoryRoots } from "../src/application/fakes.ts";
import { SecretsService, type StoreRequest } from "../src/application/secrets-service.ts";
import { SqliteSecrets } from "../src/adapters/secrets-sqlite.ts";
import { MemorySealedStore } from "./sealed-store-fake.ts";

const T = 1_700_000_000_000;
const REF = "secret://example-app/payments-test";
const OTHER = "secret://example-app/other-token";
const principal: Actor = { kind: "principal", command: "c1" };
const nodeGrant: SecretGrant = { subject: { kind: "node" }, modes: ["exec"], until: { kind: "open" } };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function world() {
  const root = mkdtempSync(join(tmpdir(), "morndo-secrets-service-sqlite-"));
  dirs.push(root);
  const db = join(root, "connections", "connections.db");
  const vault = new MemorySealedStore("fake1-node");
  const secrets = new SqliteSecrets(db);
  const service = new SecretsService({ clock: new ManualClock(T), ids: new CountingIds(), vault, index: new MemoryIndex(), secrets, roots: new MemoryRoots() });
  const request = (value: string, over: Partial<StoreRequest> = {}): StoreRequest => ({
    reference: REF, sealed: MemorySealedStore.seal(["fake1-node"], new TextEncoder().encode(value)), shape: null, grants: [nodeGrant],
    expiry: null, destinations: [], renew: false, ...over,
  });
  return { db, vault, secrets, service, request };
}

describe("the Secrets service over the real store", () => {
  it("criterion 12: a value revoked under one Reference is refused under any other, and survives a reopen", async () => {
    const w = world();
    expect((await w.service.store(w.request("synthetic-value-one"), principal)).ok).toBe(true);
    expect(w.service.revoke(REF, principal)).toEqual({ ok: true, value: { left: [] } });
    w.secrets.close();
    const reopened = new SqliteSecrets(w.db);
    const service = new SecretsService({ clock: new ManualClock(T + 1), ids: new CountingIds(), vault: w.vault, index: new MemoryIndex(), secrets: reopened, roots: new MemoryRoots() });
    const r = await service.store(w.request("synthetic-value-one", { reference: OTHER }), principal);
    expect(r).toEqual({ ok: false, error: { problem: "revoked" } });
    expect(w.vault.files.size).toBe(0);
    expect(service.list().map(s => [s.reference, s.status])).toEqual([[REF, "revoked"]]);
    reopened.close();
  });
  it("a rotation, a grant and a delete round-trip through the store as the service left them", async () => {
    const w = world();
    await w.service.store(w.request("synthetic-value-one"), principal);
    await w.service.store(w.request("synthetic-value-two", { shape: { keep: true } }), principal);
    w.service.grant(REF, { subject: { kind: "lane", lane: "lane-a" }, modes: ["file"], until: { kind: "lane-end" } }, principal);
    expect(w.service.list()[0]).toMatchObject({ version: 2, status: "active" });
    expect(w.service.list()[0]?.grants).toHaveLength(2);
    expect(w.service.log(REF).map(e => e.type)).toEqual(["SecretStored", "SecretRotated", "GrantAdded"]);
    expect(w.service.delete(REF, principal).ok).toBe(true);
    expect(w.service.list()).toEqual([]);
    expect(w.vault.files.size).toBe(0);
    w.secrets.close();
  });
});
