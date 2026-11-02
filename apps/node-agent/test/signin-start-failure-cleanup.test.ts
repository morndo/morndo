import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AccountHomes } from "../src/signin/homes.ts";
import { SignInRunner } from "../src/signin/runner.ts";
import type { SignInTerminal } from "../src/signin/terminal.ts";
import { tmuxTerminal } from "../src/signin/terminal.ts";

const FAKE = join(import.meta.dirname, "../../../test/fixtures/fake-signin-cli.mjs");
const SOCKET = `signin-fail-open-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const bins = { claude: FAKE, cursor: FAKE };

const hasSession = (id: string) => {
  try { execFileSync("tmux", ["-L", SOCKET, "has-session", "-t", `=${id}`], { stdio: "ignore" }); return true; } catch { return false; }
};

describe("sign-in start failure cleanup", () => {
  let home = "";
  let runner: SignInRunner;
  let terminal: SignInTerminal;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "signin-fail-home-"));
    terminal = tmuxTerminal(SOCKET);
    runner = new SignInRunner({
      terminal,
      homes: new AccountHomes({ home, bins, claudePool: null }),
      bins,
      now: () => Date.now(),
    });
  });

  afterAll(() => {
    try { execFileSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" }); } catch { /* none */ }
  });

  it("removes a created home and leaves no tmux session when the terminal cannot open", async () => {
    const dir = join(home, ".claude-accounts", "b1");
    const broken: SignInTerminal = {
      ...terminal,
      open: async () => { throw new Error("open refused"); },
    };
    runner = new SignInRunner({
      terminal: broken,
      homes: new AccountHomes({ home, bins, claudePool: null }),
      bins,
      now: () => Date.now(),
    });
    const out = await runner.start({ id: "si-broken", runtime: "claude", account: "b1", create: true });
    expect(out.ok).toBe(false);
    expect(existsSync(dir)).toBe(false);
    expect(hasSession("si-broken")).toBe(false);
  });
});
