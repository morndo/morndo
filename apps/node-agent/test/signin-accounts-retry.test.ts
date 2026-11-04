import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AccountHomes } from "../src/signin/homes.ts";
import { SignInRunner } from "../src/signin/runner.ts";
import { tmuxTerminal } from "../src/signin/terminal.ts";

const SOCKET = `signin-retry-${process.pid}`;

describe("sign-in accounts auth status retry", () => {
  let home = "";
  let counter = "";
  let claudeBin = "";
  let runner: SignInRunner;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "signin-retry-home-"));
    counter = join(home, "auth-status-count");
    writeFileSync(counter, "0");
    claudeBin = join(home, "claude-flaky");
    writeFileSync(claudeBin, `#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
const HOME = process.env.HOME ?? "";
const args = process.argv.slice(2);
if (args[0] !== "auth" || args[1] !== "status") process.exit(2);
const n = Number(readFileSync(${JSON.stringify(counter)}, "utf8")) + 1;
writeFileSync(${JSON.stringify(counter)}, String(n));
if (n <= 2) { process.stdout.write("not-json-garbage\\n"); process.exit(1); }
const dir = process.env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude");
mkdirSync(dir, { recursive: true });
const creds = join(dir, ".credentials.json");
writeFileSync(creds, JSON.stringify({ claudeAiOauth: { subscriptionType: "max" } }));
chmodSync(creds, 0o600);
process.stdout.write(JSON.stringify({ loggedIn: true, email: "person@example.com", subscriptionType: "max" }) + "\\n");
process.exit(0);
`);
    chmodSync(claudeBin, 0o755);
    runner = new SignInRunner({
      terminal: tmuxTerminal(SOCKET),
      homes: new AccountHomes({ home, bins: { claude: claudeBin, cursor: claudeBin }, claudePool: null }),
      bins: { claude: claudeBin, cursor: claudeBin },
      now: () => Date.now(),
    });
  });

  it("retries claude auth status and reports ok after transient garbage", async () => {
    const listed = await runner.accounts({ runtime: "claude" });
    if (!listed.ok) throw new Error(listed.error.message);
    const main = listed.result.accounts.find(a => a.name === "main");
    expect(main?.signedIn).toBe("ok");
    expect(Number(readFileSync(counter, "utf8"))).toBeGreaterThanOrEqual(3);
  });
});
