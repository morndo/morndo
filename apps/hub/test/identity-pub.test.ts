// The identity's public key where the fleet reads it (updates §5.4, PR 6c round 2, R2): the hub writes
// <dataDir>/identity.pub at every start — the 32 raw bytes as one line of base64, mode 0644, written atomically
// (a temp file beside it, then the rename) — and the fleet's principal check reads it afresh at each ask. Nothing
// else wrote that key anywhere, so a production fleet without a pinned principalKey stayed closed.
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateIdentity, writeIdentityPub } from "../src/adapters/identity.ts";

describe("identity.pub, the hub's public key for the fleet's principal check (PR 6c R2)", () => {
  it("a start writes the identity's key: one base64 line of its 32 bytes, mode 0644, atomically replaceable", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-hub-"));
    try {
      const identity = loadOrCreateIdentity(dir);
      writeIdentityPub(dir, identity.publicKeyRaw);
      const file = join(dir, "identity.pub");
      const text = readFileSync(file, "utf8");
      expect(text).toBe(`${identity.publicKeyRaw.toString("base64")}\n`);   // one line: what the fleet reads and trims
      expect(Buffer.from(text.trim(), "base64")).toEqual(identity.publicKeyRaw);
      expect(statSync(file).mode & 0o777).toBe(0o644);
      // every start writes it again, replacing what stood there; the temp file never survives
      writeFileSync(file, "a hand had edited it\n");
      writeIdentityPub(dir, identity.publicKeyRaw);
      expect(readFileSync(file, "utf8")).toBe(text);
      expect(readdirSync(dir).filter(f => f.endsWith(".tmp"))).toEqual([]);
      // and the file a fresh hub would write is the same one the fleet would read for a second identity
      const other = generateKeyPairSync("ed25519");
      const otherRaw = Buffer.from((other.publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url");
      writeIdentityPub(dir, otherRaw);
      expect(Buffer.from(readFileSync(file, "utf8").trim(), "base64")).toEqual(otherRaw);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
