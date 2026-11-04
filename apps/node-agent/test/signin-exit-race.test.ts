// tmux can mark a pane dead before it has the exit status (#{pane_dead_status} empty), and a busy tmux can fail one
// display-message. Neither is a failed sign-in: the runner waits, or asks the CLI whether it is signed in (CI saw a good
// code end "failed" in 264 ms on a loaded runner).
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Encrypter } from "age-encryption";
import { describe, expect, it } from "vitest";
import { AccountHomes } from "../src/signin/homes.ts";
import { SignInRunner } from "../src/signin/runner.ts";
import type { SignInTerminal } from "../src/signin/terminal.ts";

const FAKE = join(import.meta.dirname, "../../../test/fixtures/fake-signin-cli.mjs");
const SCREEN = "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=s1\nPaste code here if prompted > ";

type Pane = "alive" | "dead-unknown" | "dead-0" | "busy";
function setup() {
  const pane = { now: "alive" as Pane };
  const home = mkdtempSync(join(tmpdir(), "race-home-"));
  const terminal: SignInTerminal = {
    open: async () => {}, screen: async () => SCREEN, type: async () => {}, enter: async () => {}, close: async () => {},
    exit: async () => {
      if (pane.now === "busy") { pane.now = "alive"; throw new Error("tmux: server busy"); }
      return pane.now === "alive" ? { dead: false, status: null } : { dead: true, status: pane.now === "dead-0" ? 0 : null };
    },
  };
  const bins = { claude: FAKE, cursor: FAKE };
  const runner = new SignInRunner({ terminal, homes: new AccountHomes({ home, bins, claudePool: null }), bins, now: () => Date.now() });
  const login = () => {   // what the CLI writes when the code is good
    const dir = join(home, ".claude-accounts", "a1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "x", refreshToken: "y", subscriptionType: "max" } }));
    chmodSync(join(dir, ".credentials.json"), 0o600);
  };
  return { runner, login, pane };
}
async function codeIn(runner: SignInRunner) {
  const s = await runner.start({ id: "si-race", runtime: "claude", account: "a1", create: true });
  if (!s.ok) throw new Error(s.error.message);
  const e = new Encrypter();
  e.addRecipient(s.result.recipient!);
  expect((await runner.code({ id: "si-race", sealed: Buffer.from(await e.encrypt("good-code")).toString("base64") })).ok).toBe(true);
}

describe("the end of a sign-in, when tmux is slow to say how it ended", () => {
  it("a dead pane without an exit status yet is no failure: the CLI's own status decides", async () => {
    const { runner, login, pane } = setup();
    await codeIn(runner);
    expect((await runner.status({ id: "si-race" }))).toMatchObject({ ok: true, result: { phase: "checking" } });
    login();                                    // the CLI writes its login, then exits
    pane.now = "dead-unknown";
    expect((await runner.status({ id: "si-race" }))).toEqual({ ok: true, result: { phase: "done", identity: { email: "person@example.com", plan: "max" }, problem: null } });
  });

  it("one failed tmux call is no failure either: the next status asks again", async () => {
    const { runner, login, pane } = setup();
    await codeIn(runner);
    pane.now = "busy";
    expect((await runner.status({ id: "si-race" }))).toMatchObject({ ok: true, result: { phase: "checking" } });
    login();
    pane.now = "dead-0";
    expect((await runner.status({ id: "si-race" }))).toMatchObject({ ok: true, result: { phase: "done" } });
  });
});
