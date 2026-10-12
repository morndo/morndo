// The Secrets service's store flow (PLAN step 10, criteria 12, 19 and 20; design §6, D2), over in-memory ports and the
// fake sealed store. Values, References and fingerprints are synthetic.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Actor, type SecretGrant } from "@morndo/domain";
import { CountingIds, ManualClock, MemoryIndex, MemoryRoots, MemorySecrets } from "../src/application/fakes.ts";
import { SecretsService, type StoreRequest } from "../src/application/secrets-service.ts";
import { MemorySealedStore } from "./sealed-store-fake.ts";

const T = 1_700_000_000_000;
const REF = "secret://example-app/payments-test";
const OTHER = "secret://example-app/other-token";
const principal: Actor = { kind: "principal", command: "c1" };
const nodeGrant: SecretGrant = { subject: { kind: "node" }, modes: ["exec"], until: { kind: "open" } };
const text = (s: string) => new TextEncoder().encode(s);

function world() {
  const vault = new MemorySealedStore("fake1-node");
  const index = new MemoryIndex(async ref => (await vault.open(ref)).bytes().length < 8);
  const secrets = new MemorySecrets();
  const clock = new ManualClock(T);
  const service = new SecretsService({ clock, ids: new CountingIds(), vault, index, secrets, roots: new MemoryRoots() });
  const request = (value: string, over: Partial<StoreRequest> = {}): StoreRequest => ({
    reference: REF, sealed: MemorySealedStore.seal(["fake1-node"], text(value)), shape: null, grants: [nodeGrant], expiry: null,
    destinations: [], renew: false, ...over,
  });
  return { vault, index, secrets, clock, service, request };
}

describe("a store: seal under a fresh ref, then the check, the index and the save in one transaction (D2)", () => {
  it("stores version 1, with its vault ref recorded and its index entries written before it returns (criterion 19)", async () => {
    const w = world();
    const r = await w.service.store(w.request("synthetic-value-one"), principal);
    expect(r).toEqual({ ok: true, value: { reference: REF, version: 1, at: T, sameAs: [], indexed: true, renewed: false } });
    expect([...w.vault.files.keys()]).toEqual(["s-0001"]);
    expect(w.secrets.state.vaults).toEqual([{ reference: REF, version: 1, ref: "s-0001" }]);
    expect(w.index.changes).toEqual([{ add: { reference: REF, version: 1, prepared: { short: false } }, retire: [], at: T }]);
    expect(w.secrets.state.directory.events.map(e => e.type)).toEqual(["SecretStored"]);
  });
  it("a refused store leaves no new vault file and writes no index entry (criterion 19)", async () => {
    const w = world();
    await w.service.store(w.request("synthetic-value-one"), principal);
    const again = await w.service.store(w.request("synthetic-value-one"), principal);
    expect(again).toEqual({ ok: false, error: { problem: "earlier" } });
    const agent = await w.service.store(w.request("synthetic-value-two"), { kind: "operator" });
    expect(agent).toEqual({ ok: false, error: { problem: "principal" } });
    expect([...w.vault.files.keys()]).toEqual(["s-0001"]);
    expect(w.index.changes).toHaveLength(1);
    expect(w.secrets.state.directory.events).toHaveLength(1);
  });
  it("a sealed value the vault refuses stores nothing and names why", async () => {
    const w = world();
    const r = await w.service.store(w.request("x", { sealed: MemorySealedStore.seal(["fake1-other"], text("synthetic-value-one")) }), principal);
    expect(r).toEqual({ ok: false, error: { problem: "foreign" } });
    expect(w.vault.files.size).toBe(0);
    expect(w.index.changes).toEqual([]);
    expect(w.secrets.writes).toBe(0);
  });
  it("a rotation adds version 2, retires version 1 in the index, and removes version 1's file after the save", async () => {
    const w = world();
    await w.service.store(w.request("synthetic-value-one"), principal);
    w.clock.at = T + 5;
    const r = await w.service.store(w.request("synthetic-value-two", { shape: { keep: true } }), principal);
    expect(r.ok && r.value.version).toBe(2);
    expect(w.index.changes.at(-1)).toEqual({ add: { reference: REF, version: 2, prepared: { short: false } }, retire: [{ reference: REF, version: 1 }], at: T + 5 });
    expect([...w.vault.files.keys()]).toEqual(["s-0002"]);
    expect(w.secrets.state.vaults).toEqual([{ reference: REF, version: 1, ref: null }, { reference: REF, version: 2, ref: "s-0002" }]);
  });
  it("a value under 8 bytes is stored, not indexed, and says so", async () => {
    const w = world();
    const r = await w.service.store(w.request("short"), principal);
    expect(r.ok && r.value.indexed).toBe(false);
    expect(w.index.changes[0]?.add?.prepared).toEqual({ short: true });
  });
  it("a failure while preparing the index or saving leaves no new vault file", async () => {
    const w = world();
    w.index.prepare = () => Promise.reject(new Error("index unreadable"));
    await expect(w.service.store(w.request("synthetic-value-one"), principal)).rejects.toThrow(/index unreadable/);
    expect(w.vault.files.size).toBe(0);
    const v = world();
    v.index.write = () => { throw new Error("disk full"); };
    await expect(v.service.store(v.request("synthetic-value-one"), principal)).rejects.toThrow(/disk full/);
    expect(v.vault.files.size).toBe(0);
    expect(v.secrets.writes).toBe(0);
  });
  it("a renew is held to the renew rule, and says it renewed", async () => {
    const w = world();
    await w.service.store(w.request("synthetic-value-one", { expiry: T + 10 }), principal);
    const late = await w.service.store(w.request("synthetic-value-two", { renew: true, expiry: T + 5 }), principal);
    expect(late).toEqual({ ok: false, error: { problem: "renew_expiry" } });
    const r = await w.service.store(w.request("synthetic-value-two", { renew: true, expiry: T + 100, shape: { keep: true } }), principal);
    expect(r.ok && r.value).toMatchObject({ version: 2, renewed: true });
    expect([...w.vault.files.keys()]).toEqual(["s-0003"]);
  });
});

describe("criterion 12: a revoked fingerprint is refused under any Reference on the node", () => {
  it("through the service: a value revoked under one Reference can't be stored under another", async () => {
    const w = world();
    await w.service.store(w.request("synthetic-value-one"), principal);
    const s = w.secrets.state;
    w.secrets.state = { ...s, directory: { ...s.directory, ledger: s.directory.ledger.map(e => ({ ...e, state: "revoked" as const })) } };
    const r = await w.service.store(w.request("synthetic-value-one", { reference: OTHER }), principal);
    expect(r).toEqual({ ok: false, error: { problem: "revoked" } });
    expect([...w.vault.files.keys()]).toEqual(["s-0001"]);
  });
});

describe("criterion 20: the Secrets service is application code", () => {
  const code = readFileSync(join(import.meta.dirname, "../src/application/secrets-service.ts"), "utf8");
  it("imports only the domain, the protocol and its siblings; no node agent, no plaintext type, no Node global", () => {
    const specs = [...code.matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']/g)].map(m => m[1] ?? "");
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.filter(s => !(/^\.\/[\w-]+\.ts$/.test(s) || s === "@morndo/domain" || s === "@morndo/protocol"))).toEqual([]);
    expect(code).not.toMatch(/node-agent|secret-material|SecretMaterial/);
    expect(code).not.toMatch(/\b(?:Buffer|process|require|crypto|fetch)\b|Date\.now|new Date\(/);
  });
});

// ---- PLAN step 11: the lifecycle commands, the log, workspaces and the startup sweep.

describe("the lifecycle (SC7, SC8)", () => {
  const stored = async () => {
    const w = world();
    const r = await w.service.store(w.request("synthetic-value-one"), principal);
    if (!r.ok) throw new Error(r.error.problem);
    return w;
  };
  // Widening by effect (SC7): the node-wide Grant covers exec already, so the lane's Grant adds a mode.
  const laneGrant: SecretGrant = { subject: { kind: "lane", lane: "lane-a" }, modes: ["file"], until: { kind: "open" } };

  it("a store names the other References that hold the same value", async () => {
    const w = await stored();
    const r = await w.service.store(w.request("synthetic-value-one", { reference: OTHER }), principal);
    expect(r.ok && r.value.sameAs).toEqual([REF]);
  });
  it("grant and ungrant: widening is the principal's, narrowing anyone's", () => stored().then(w => {
    expect(w.service.grant(REF, laneGrant, { kind: "operator" })).toEqual({ ok: false, error: { problem: "principal" } });
    expect(w.service.grant(REF, laneGrant, principal)).toEqual({ ok: true, value: null });
    expect(w.service.list()[0]?.grants).toHaveLength(2);
    expect(w.service.ungrant(REF, { kind: "lane", lane: "lane-a" }, { kind: "operator" })).toEqual({ ok: true, value: null });
    expect(w.service.ungrant(REF, { kind: "lane", lane: "lane-a" }, principal)).toEqual({ ok: false, error: { problem: "missing" } });
  }));
  it("disable is anyone's (SC7); enable is the principal's", () => stored().then(w => {
    expect(w.service.disable(REF, { kind: "operator" })).toEqual({ ok: true, value: null });
    expect(w.service.list()[0]?.status).toBe("disabled");
    expect(w.service.enable(REF, { kind: "operator" })).toEqual({ ok: false, error: { problem: "principal" } });
    expect(w.service.enable(REF, principal)).toEqual({ ok: true, value: null });
    expect(w.service.disable("secret://example-app/nope", principal)).toEqual({ ok: false, error: { problem: "missing" } });
  }));
  it("revoke removes the vault file, retires the version in the index, and keeps the Reference (SC8)", () => stored().then(w => {
    w.clock.at = T + 9;
    expect(w.service.revoke(REF, { kind: "operator" })).toEqual({ ok: false, error: { problem: "principal" } });
    expect(w.vault.files.size).toBe(1);
    expect(w.service.revoke(REF, principal)).toEqual({ ok: true, value: null });
    expect(w.vault.files.size).toBe(0);
    expect(w.index.changes.at(-1)).toEqual({ add: null, retire: [{ reference: REF, version: 1 }], at: T + 9 });
    expect(w.secrets.state.vaults).toEqual([{ reference: REF, version: 1, ref: null }]);
    expect(w.service.list()[0]).toMatchObject({ reference: REF, status: "revoked", version: null });
  }));
  it("delete removes the Reference and its file; the ledger keeps the value refused", () => stored().then(async w => {
    expect(w.service.delete(REF, principal)).toEqual({ ok: true, value: null });
    expect(w.vault.files.size).toBe(0);
    expect(w.service.list()).toEqual([]);
    expect(w.index.changes.at(-1)?.retire).toEqual([{ reference: REF, version: 1 }]);
    const again = await w.service.store(w.request("synthetic-value-one"), principal);
    expect(again).toEqual({ ok: false, error: { problem: "earlier" } });
  }));
  it("a revoked value is refused under another Reference, through revoke itself (criterion 12)", () => stored().then(async w => {
    w.service.revoke(REF, principal);
    const r = await w.service.store(w.request("synthetic-value-one", { reference: OTHER }), principal);
    expect(r).toEqual({ ok: false, error: { problem: "revoked" } });
    expect(w.vault.files.size).toBe(0);
  }));
  it("the log lists the events, for one Reference or all, and list shows metadata only", () => stored().then(w => {
    w.service.disable(REF, principal);
    expect(w.service.log(REF).map(e => e.type)).toEqual(["SecretStored", "SecretDisabled"]);
    expect(w.service.log(OTHER)).toEqual([]);
    expect(w.service.log(null)).toHaveLength(2);
    expect(Object.keys(w.service.list()[0] ?? {}).sort()).toEqual(["destinations", "expiry", "grants", "reference", "shape", "status", "storedAt", "version"]);
  }));
});

describe("workspaces (design §6)", () => {
  it("a path registers the repository its git common dir names, once, by the principal only", () => {
    const w = world();
    const roots = new MemoryRoots();
    roots.repos.set("/work/example-app", "/work/example-app/.git");
    roots.repos.set("/work/wt/example-app-b", "/work/example-app/.git");
    const service = new SecretsService({ clock: w.clock, ids: new CountingIds(), vault: w.vault, index: w.index, secrets: w.secrets, roots });
    expect(service.addWorkspace("/work/example-app/src", { kind: "operator" })).toEqual({ ok: false, error: { problem: "principal" } });
    expect(service.addWorkspace("/elsewhere", principal)).toEqual({ ok: false, error: { problem: "not_repository" } });
    expect(service.addWorkspace("/work/example-app/src", principal)).toEqual({ ok: true, value: { name: "example-app", root: "/work/example-app/.git", at: T, command: "c1" } });
    expect(service.addWorkspace("/work/wt/example-app-b", principal)).toEqual({ ok: false, error: { problem: "same" } });
    expect(service.workspaces()).toHaveLength(1);
  });
  it("another repository with the same directory name is refused, not merged", () => {
    const w = world();
    const roots = new MemoryRoots();
    roots.repos.set("/a/example-app", "/a/example-app/.git");
    roots.repos.set("/b/example-app", "/b/example-app/.git");
    const service = new SecretsService({ clock: w.clock, ids: new CountingIds(), vault: w.vault, index: w.index, secrets: w.secrets, roots });
    expect(service.addWorkspace("/a/example-app", principal).ok).toBe(true);
    expect(service.addWorkspace("/b/example-app", principal)).toEqual({ ok: false, error: { problem: "workspace_taken" } });
  });
});

describe("the startup sweep (D2)", () => {
  it("removes a vault file no version refers to, and keeps the rest", async () => {
    const w = world();
    await w.service.store(w.request("synthetic-value-one"), principal);
    await w.vault.storeSealed("s-9999", MemorySealedStore.seal(["fake1-node"], text("synthetic-left-over")));
    expect(w.service.sweep()).toEqual(["s-9999"]);
    expect([...w.vault.files.keys()]).toEqual(["s-0001"]);
  });
  it("a store whose file was swept before its commit fails and saves nothing", async () => {
    const w = world();
    const prepare = w.index.prepare.bind(w.index);
    w.index.prepare = async ref => { const p = await prepare(ref); w.service.sweep(); return p; };
    await expect(w.service.store(w.request("synthetic-value-one"), principal)).rejects.toThrow(/swept/);
    expect(w.secrets.writes).toBe(0);
  });
});

// ---- The index retires a version only after the commit that retired it (found while wiring the index writer, T-94).

describe("a rolled-back change never retires a live version in the index", () => {
  const retired = (w: ReturnType<typeof world>) => w.index.changes.flatMap(c => c.retire.map(r => r.version));
  it("a rotation whose save fails leaves version 1 live in the index; its file stays", async () => {
    const w = world();
    await w.service.store(w.request("synthetic-value-one"), principal);
    w.secrets.failNextSave = true;
    await expect(w.service.store(w.request("synthetic-value-two", { shape: { keep: true } }), principal)).rejects.toThrow(/the save failed/);
    expect(retired(w)).toEqual([]);
    expect([...w.vault.files.keys()]).toEqual(["s-0001"]);
  });
  it("a revoke whose save fails retires nothing and removes nothing", async () => {
    const w = world();
    await w.service.store(w.request("synthetic-value-one"), principal);
    w.secrets.failNextSave = true;
    expect(() => w.service.revoke(REF, principal)).toThrow(/the save failed/);
    expect(retired(w)).toEqual([]);
    expect(w.vault.files.size).toBe(1);
  });
  it("after a crash between the commit and the retirement, the sweep retires what the ledger no longer holds current", async () => {
    const w = world();
    await w.service.store(w.request("synthetic-value-one"), principal);
    await w.service.store(w.request("synthetic-value-two", { shape: { keep: true } }), principal);
    w.index.changes.length = 0;
    w.clock.at = T + 50;
    w.service.sweep();
    expect(w.index.changes).toEqual([{ add: null, retire: [{ reference: REF, version: 1 }], at: T + 50 }]);
  });
});
