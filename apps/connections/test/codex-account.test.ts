// A pool member's account as the CLI's app server tells it (ADR-0029, §6.6): who, which plan, the windows, whether ordinary use
// is allowed and the reset credits, with no email kept. A fake app server stands in; no sign-in is used.
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCodexAccount, readingFromAnswers } from "../src/adapters/codex-account.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const json = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, "codex", name), "utf8"));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Seen = { calls: { method: string; params: unknown }[] };

function server(account: unknown = json("account-plus.json")): { bin: string; dir: string; seen(): Seen } {
  const dir = mkdtempSync(join(tmpdir(), "morndo-codex-account-"));
  dirs.push(dir);
  const bin = join(dir, "codex.mjs");
  copyFileSync(join(FIXTURES, "fake-codex-app-server.mjs"), bin);
  copyFileSync(join(FIXTURES, "codex", "rate-limits-pool.json"), join(dir, "limits.json"));
  writeFileSync(join(dir, "account.json"), JSON.stringify(account));
  return { bin, dir, seen: () => JSON.parse(readFileSync(join(dir, "seen.json"), "utf8")) as Seen };
}
const env = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? "" });

describe("codex account: the reading", () => {
  it("reads who, which plan, the windows, whether use is allowed and the reset credits, and keeps no email", async () => {
    const s = server();
    const read = await readCodexAccount({ bin: s.bin, env: env(), version: "9.9.9" });
    expect(read).toEqual({
      ok: true,
      reading: {
        signedIn: true, identity: createHash("sha256").update("acct-synthetic-0001").digest("hex").slice(0, 12), plan: "plus", paid: true,
        windows: [{ usedPercent: 42, minutes: 300, resetsAt: 1_893_456_000_000 }, { usedPercent: 17, minutes: 10_080, resetsAt: 1_893_888_000_000 }],
        allowed: true, credits: { available: 2, expiresAt: 1_894_060_800_000 },
      },
    });
    expect(JSON.stringify(read)).not.toContain("@");
    expect(s.seen().calls).toEqual([
      { method: "initialize", params: { clientInfo: { name: "morndo", title: "Morndo", version: "9.9.9" } } },
      { method: "account/read", params: { refreshToken: false } },
      { method: "account/rateLimits/read", params: { excludeResetCreditDetails: false } },
    ]);
  });

  it("says signed out when the account is null or is not a ChatGPT login", async () => {
    const out = await readCodexAccount({ bin: server({ account: null, requiresOpenaiAuth: true }).bin, env: env(), version: "1" });
    expect(out).toEqual({ ok: true, reading: { signedIn: false, identity: null, plan: null, paid: null, windows: [], allowed: null, credits: null } });
    const key = await readCodexAccount({ bin: server({ account: { type: "apiKey" }, requiresOpenaiAuth: false }).bin, env: env(), version: "1" });
    expect(key).toMatchObject({ ok: true, reading: { signedIn: false } });
  });

  it("counts free, go and unknown plans as not paid, and falls back to a digest of the email when the backend names no account", () => {
    const limits = (planType: string): unknown => ({ rateLimits: { primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1 }, secondary: null, planType }, accountId: null });
    const account = (planType: string): unknown => ({ account: { type: "chatgpt", email: "someone@example.com", planType }, requiresOpenaiAuth: true });
    const paid = (plan: string) => readingFromAnswers(account(plan), limits(plan))?.paid;
    expect(["free", "go", "unknown", "plus", "pro", "team"].map(paid)).toEqual([false, false, false, true, true, true]);
    const reading = readingFromAnswers(account("plus"), limits("plus"));
    expect(reading?.identity).toBe(createHash("sha256").update("someone@example.com").digest("hex").slice(0, 12));
    expect(readingFromAnswers(account("plus"), { rateLimits: { primary: { usedPercent: "x" } } })).toBeNull();
    expect(readingFromAnswers({ nope: true }, limits("plus"))).toBeNull();
  });
});
