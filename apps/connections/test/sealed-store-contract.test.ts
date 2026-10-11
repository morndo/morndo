// The store port's contract (PLAN steps 6 and 7, criteria 1 to 7; design §15.2): one suite, run against each adapter.
// A case that applies only to file adapters is registered only for them, never skipped. Values are synthetic.
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Encrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import { afterEach, describe, expect, it } from "vitest";
import type { SealedStore } from "../src/application/ports.ts";
import { FileRefused, durable } from "../src/adapters/file-mode.ts";
import { AgeVault } from "../src/adapters/vault-age.ts";

const value = new TextEncoder().encode("synthetic-sealed-value-0123");
const other = new TextEncoder().encode("synthetic-sealed-value-4567");
const realFsync = durable.fsync;
let roots: string[] = [];
afterEach(() => {
  durable.fsync = realFsync;
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

async function sealTo(recipients: readonly string[], bytes: Uint8Array): Promise<Uint8Array> {
  const e = new Encrypter();
  for (const r of recipients) e.addRecipient(r);
  return e.encrypt(bytes);
}
const stranger = async () => identityToRecipient(await generateX25519Identity());

// One adapter under test: a fresh store on a fresh node, the means to seal to it, and what it can do.
type Subject = {
  store: SealedStore;
  // A sealed value for this store's node; null where the adapter takes none (the plaintext vault).
  seal(bytes: Uint8Array): Promise<Uint8Array>;
  sealForOthers(bytes: Uint8Array, alsoMine: boolean): Promise<Uint8Array>;
  open(ref: string): Promise<Uint8Array>;
  // File adapters: the vault directory, the identity file and the node's home; null for the in-memory fake.
  files: { vault: string; identity: string; home: string; withUid(uid: number): SealedStore } | null;
};
type Adapter = { name: string; sealing: boolean; make(home?: string): Promise<Subject> };

const node = () => {
  const root = mkdtempSync(join(tmpdir(), "morndo-sealed-"));
  roots.push(root);
  return join(root, "connections");
};

const ageVault: Adapter = {
  name: "vault-age",
  sealing: true,
  async make(home = node()) {
    const vault = join(home, "vault");
    const identity = join(home, "identity");
    const store = new AgeVault(vault, identity);
    const mine = await store.recipient();
    return {
      store,
      seal: bytes => sealTo([mine], bytes),
      sealForOthers: async (bytes, alsoMine) => sealTo(alsoMine ? [mine, await stranger()] : [await stranger()], bytes),
      open: async ref => (await store.open(ref)).bytes(),
      files: { vault, identity, home, withUid: uid => new AgeVault(vault, identity, uid) },
    };
  },
};

const ADAPTERS: readonly Adapter[] = [ageVault];

for (const adapter of ADAPTERS) {
  describe(`the sealed store contract: ${adapter.name}`, () => {
    if (adapter.sealing) {
      it("criterion 3: storeSealed, then the adapter's own open, gives the bytes back", async () => {
        const s = await adapter.make();
        const r = await s.store.storeSealed("s-0001", await s.seal(value));
        expect(r.ok).toBe(true);
        expect(await s.open("s-0001")).toEqual(value);
        expect(s.store.has("s-0001")).toBe(true);
      });
      it("criterion 4: a value sealed to another recipient, or to two, is refused and nothing is left", async () => {
        const s = await adapter.make();
        expect(await s.store.storeSealed("s-0002", await s.sealForOthers(value, false))).toEqual({ ok: false, problem: "foreign" });
        expect(await s.store.storeSealed("s-0003", await s.sealForOthers(value, true))).toEqual({ ok: false, problem: "stanzas" });
        expect(await s.store.storeSealed("s-0004", new TextEncoder().encode("not an age file at all"))).toEqual({ ok: false, problem: "not_age" });
        for (const ref of ["s-0002", "s-0003", "s-0004"]) expect(s.store.has(ref), ref).toBe(false);
        if (s.files && existsSync(s.files.vault)) expect(readdirSync(s.files.vault)).toEqual([]);
      });
      it("criterion 8 (15.2): the keyed fingerprint is stable on a node and differs across nodes for one value", async () => {
        const home = node();
        const a = await adapter.make(home);
        const stored = await a.store.storeSealed("s-0005", await a.seal(value));
        if (!stored.ok) throw new Error(stored.problem);
        expect(stored.fingerprint).toMatch(/^[0-9a-f]{12}$/);
        expect(await a.store.keyedFingerprint("s-0005")).toBe(stored.fingerprint);
        const again = await adapter.make(home);
        const second = await again.store.storeSealed("s-0006", await again.seal(value));
        expect(second.ok && second.fingerprint).toBe(stored.fingerprint);
        const b = await adapter.make();
        const elsewhere = await b.store.storeSealed("s-0005", await b.seal(value));
        expect(elsewhere.ok && elsewhere.fingerprint).not.toBe(stored.fingerprint);
      });
      it("criterion 7: remove leaves nothing", async () => {
        const s = await adapter.make();
        await s.store.storeSealed("s-0007", await s.seal(value));
        s.store.remove("s-0007");
        expect(s.store.has("s-0007")).toBe(false);
        expect(await s.store.keyedFingerprint("s-0007")).toBeNull();
        if (s.files) expect(readdirSync(s.files.vault)).toEqual([]);
      });
      it("a replace under one ref leaves the newer value", async () => {
        const s = await adapter.make();
        await s.store.storeSealed("s-0008", await s.seal(value));
        await s.store.storeSealed("s-0008", await s.seal(other));
        expect(await s.open("s-0008")).toEqual(other);
      });
    }
    if (adapter.sealing && adapter.name !== "fake") {
      it("criterion 6: a crash between the write and the rename leaves the old version readable", async () => {
        const s = await adapter.make();
        await s.store.storeSealed("s-0009", await s.seal(value));
        const sealed = await s.seal(other);
        durable.fsync = () => { throw new Error("crash before the rename"); };
        await expect(s.store.storeSealed("s-0009", sealed)).rejects.toThrow(/crash before the rename/);
        durable.fsync = realFsync;
        expect(await s.open("s-0009")).toEqual(value);
        if (s.files) expect(readdirSync(s.files.vault).filter(n => n.includes(".tmp"))).toEqual([]);
      });
    }
    it("criterion 7: has opens nothing: with the identity gone it still answers, and makes none", async () => {
      const s = await adapter.make();
      if (adapter.sealing) await s.store.storeSealed("s-0010", await s.seal(value));
      if (!s.files) {
        expect(s.store.has("s-0010")).toBe(adapter.sealing);
        return;
      }
      rmSync(s.files.identity, { force: true });
      expect(s.store.has("s-0010")).toBe(adapter.sealing);
      expect(existsSync(s.files.identity)).toBe(false);
    });
  });
}

for (const adapter of ADAPTERS.filter(a => a.sealing && a.name !== "fake")) {
  describe(`file adapters: ${adapter.name}`, () => {
    it("criterion 5: a 0644 vault file is refused before it is read", async () => {
      const s = await adapter.make();
      await s.store.storeSealed("s-0011", await s.seal(value));
      if (!s.files) throw new Error("a file adapter");
      chmodSync(join(s.files.vault, "s-0011.age"), 0o644);
      expect(() => s.store.has("s-0011")).toThrow(FileRefused);
      await expect(s.store.keyedFingerprint("s-0011")).rejects.toThrow(FileRefused);
    });
    it("criterion 5: a vault file with a foreign owner is refused before it is read", async () => {
      const s = await adapter.make();
      await s.store.storeSealed("s-0012", await s.seal(value));
      if (!s.files) throw new Error("a file adapter");
      const foreign = s.files.withUid(statSync(s.files.vault).uid + 1);
      expect(() => foreign.has("s-0012")).toThrow(/owned by someone else/);
      await expect(foreign.keyedFingerprint("s-0012")).rejects.toThrow(/owned by someone else/);
    });
  });
}
