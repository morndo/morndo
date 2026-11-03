// The Accounts list names each account's email (ADR-0039, amended): the signed-in email from the CLI's own status, else the
// last one the account's own settings file holds, else none. Shown to the principal; never stored by the hub.
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AccountHomes } from "../src/signin/homes.ts";
import { SignInRunner } from "../src/signin/runner.ts";
import { tmuxTerminal } from "../src/signin/terminal.ts";

const FAKE = join(import.meta.dirname, "../../../test/fixtures/fake-signin-cli.mjs");

describe("each account's email in the list", () => {
  it("signed in: the CLI's email and plan; signed out: the last email its settings hold; neither: none", async () => {
    const home = mkdtempSync(join(tmpdir(), "acct-email-"));
    const a1 = join(home, ".claude-accounts", "a1");
    mkdirSync(a1, { recursive: true });
    writeFileSync(join(a1, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "x", refreshToken: "y", subscriptionType: "max" } }));
    chmodSync(join(a1, ".credentials.json"), 0o600);
    const a2 = join(home, ".claude-accounts", "a2");
    mkdirSync(a2, { recursive: true });
    writeFileSync(join(a2, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "earlier@example.com", organizationType: "claude_max" } }));
    mkdirSync(join(home, ".claude-accounts", "a3"), { recursive: true });
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "main@example.com" } }));
    mkdirSync(join(home, ".config", "cursor"), { recursive: true });
    writeFileSync(join(home, ".config", "cursor", "auth.json"), "{}");
    const bins = { claude: FAKE, cursor: FAKE };
    const runner = new SignInRunner({ terminal: tmuxTerminal(`acct-email-${process.pid}`), homes: new AccountHomes({ home, bins, claudePool: null }), bins, now: () => Date.now() });
    const claude = await runner.accounts({ runtime: "claude" });
    if (!claude.ok) throw new Error(claude.error.message);
    expect(claude.result.accounts.map(a => [a.name, a.signedIn, a.email, a.plan])).toEqual([
      ["main", "missing", "main@example.com", null],
      ["a1", "ok", "person@example.com", "max"],
      ["a2", "missing", "earlier@example.com", null],
      ["a3", "missing", null, null],
    ]);
    const cursor = await runner.accounts({ runtime: "cursor" });
    if (!cursor.ok) throw new Error(cursor.error.message);
    expect(cursor.result.accounts).toEqual([{ name: "main", signedIn: "ok", retired: false, plan: null, email: "person@example.com" }]);
  });
});
