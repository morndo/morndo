import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SIGNIN_TTL_MS } from "@morndo/domain";
import { AccountHomes } from "../src/signin/homes.ts";
import { SignInRunner } from "../src/signin/runner.ts";
import { tmuxTerminal } from "../src/signin/terminal.ts";

const FAKE = join(import.meta.dirname, "../../../test/fixtures/fake-signin-cli.mjs");
const SOCKET = `signin-reap-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const bins = { claude: FAKE, cursor: FAKE };

const hasSession = (id: string) => {
  try { execFileSync("tmux", ["-L", SOCKET, "has-session", "-t", `=${id}`], { stdio: "ignore" }); return true; } catch { return false; }
};

describe("sign-in reap", () => {
  let home = "";
  let clock = Date.now();
  let runner: SignInRunner;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "signin-reap-home-"));
    clock = Date.now();
    runner = new SignInRunner({
      terminal: tmuxTerminal(SOCKET),
      homes: new AccountHomes({ home, bins, claudePool: null }),
      bins,
      now: () => clock,
    });
  });

  afterAll(() => {
    try { execFileSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" }); } catch { /* none left */ }
  });

  it("closes an expired sign-in tmux session when reap runs without a status call", async () => {
    expect((await runner.start({ id: "si-reap1", runtime: "claude", account: "a1", create: true })).ok).toBe(true);
    expect(hasSession("si-reap1")).toBe(true);
    clock += SIGNIN_TTL_MS + 1;
    await runner.reap();
    expect(hasSession("si-reap1")).toBe(false);
  });
});
