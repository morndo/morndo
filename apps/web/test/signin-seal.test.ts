// Sign-in from the app (ADR-0039): the browser seals the one-time code to the sign-in's own key before it leaves the page.
// Locked by the keryx run app-sign-in.
import { Decrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import { describe, expect, it } from "vitest";
import { sealCode } from "../src/lib/signin/seal.ts";

const bytes = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

describe("sealing the sign-in code in the browser", () => {
  it("seals to the sign-in's recipient as base64; only that sign-in's identity opens it", async () => {
    const identity = await generateX25519Identity();
    const sealed = await sealCode(await identityToRecipient(identity), "good-code");
    expect(sealed).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(sealed).not.toContain("good-code");
    const mine = new Decrypter();
    mine.addIdentity(identity);
    expect(await mine.decrypt(bytes(sealed), "text")).toBe("good-code");
    const other = new Decrypter();
    other.addIdentity(await generateX25519Identity());
    await expect(other.decrypt(bytes(sealed), "text")).rejects.toThrow();
  });

  it("refuses something that isn't an age X25519 recipient, and an empty code", async () => {
    await expect(sealCode("age1notarecipient", "good-code")).rejects.toThrow();
    const recipient = await identityToRecipient(await generateX25519Identity());
    await expect(sealCode(recipient, "   ")).rejects.toThrow();
  });
});
