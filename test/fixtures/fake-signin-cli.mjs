#!/usr/bin/env node
// A stand-in for the two sign-in CLIs the app drives (ADR-0039), for tests only. Locked by the keryx run app-sign-in.
// - As Claude Code: `auth login --claudeai` prints a sign-in link and waits at "Paste code here if prompted > ". The code
//   "good-code" writes a login into $CLAUDE_CONFIG_DIR (else ~/.claude): .credentials.json (0600) and .claude.json;
//   anything else prints an error and exits 1. `auth status --json` reports that login.
// - As the Cursor agent: `login` prints a link and finishes once the file "approve" appears in its config folder (what
//   the browser's approval does for the real CLI). `status` reports the login.
// Made-up values only: the link, the email and the plan are not anyone's.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const HOME = process.env.HOME ?? homedir();
const EMAIL = "person@example.com";

if (args[0] === "auth") {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude");
  const creds = join(dir, ".credentials.json");
  if (args[1] === "status") {
    if (existsSync(creds)) {
      const plan = JSON.parse(readFileSync(creds, "utf8")).claudeAiOauth.subscriptionType;
      process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: EMAIL, subscriptionType: plan }) + "\n");
      process.exit(0);
    }
    process.stdout.write(JSON.stringify({ loggedIn: false, authMethod: "none" }) + "\n");
    process.exit(1);
  }
  if (args[1] === "login") {
    const state = Math.random().toString(36).slice(2);
    process.stdout.write("Opening browser to sign in…\n");
    process.stdout.write(`If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=fake&state=${state}\n`);
    process.stdout.write("Paste code here if prompted > ");
    const rl = createInterface({ input: process.stdin });
    rl.once("line", line => {
      rl.close();
      if (line.trim() !== "good-code") {
        process.stdout.write("\nOAuth error: Invalid code\n");
        process.exit(1);
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: "fake-access", refreshToken: "fake-refresh", subscriptionType: "max" } }));
      chmodSync(creds, 0o600);
      writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: EMAIL } }));
      process.stdout.write("\nLogin successful\n");
      process.exit(0);
    });
  }
} else if (args[0] === "login" || args[0] === "status") {
  const dir = join(process.env.XDG_CONFIG_HOME ?? join(HOME, ".config"), "cursor");
  const auth = join(dir, "auth.json");
  if (args[0] === "status") {
    process.stdout.write(existsSync(auth) ? `✓ Logged in as ${EMAIL}\n` : "Not logged in\n");
    process.exit(0);
  }
  mkdirSync(dir, { recursive: true });
  process.stdout.write("Starting login process...\nWaiting for browser authentication...\n");
  process.stdout.write(`Open a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=fake&uuid=${Math.random().toString(36).slice(2)}&mode=login\n`);
  const started = Date.now();
  const wait = setInterval(() => {
    if (existsSync(join(dir, "approve"))) {
      clearInterval(wait);
      writeFileSync(auth, JSON.stringify({ accessToken: "fake-session" }));
      chmodSync(auth, 0o600);
      process.stdout.write(`✓ Logged in as ${EMAIL}\nAuthentication tokens stored securely.\n`);
      process.exit(0);
    }
    if (Date.now() - started > 120_000) { clearInterval(wait); process.stdout.write("Login timed out\n"); process.exit(1); }
  }, 200);
} else {
  process.stderr.write(`fake-signin-cli: unknown command ${args.join(" ")}\n`);
  process.exit(2);
}
