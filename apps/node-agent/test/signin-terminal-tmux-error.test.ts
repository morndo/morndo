import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AccountHomes } from "../src/signin/homes.ts";
import { SignInRunner } from "../src/signin/runner.ts";
import type { SignInTerminal } from "../src/signin/terminal.ts";

const FAKE = join(import.meta.dirname, "../../../test/fixtures/fake-signin-cli.mjs");
const SOCKET = `signin-tmux-err-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const LINK_SCREEN = "Open a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=fake&uuid=x&mode=login\n";

describe("sign-in tmux exit errors", () => {
  afterAll(() => {
    try { execFileSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" }); } catch { /* none */ }
  });

  it("does not treat a tmux server error as a dead pane while waiting for a link", async () => {
    const home = mkdtempSync(join(tmpdir(), "signin-tmux-err-home-"));
    let calls = 0;
    const terminal: SignInTerminal = {
      open: async () => {},
      screen: async () => LINK_SCREEN,
      type: async () => {},
      enter: async () => {},
      close: async () => {},
      exit: async () => {
        calls++;
        if (calls === 1) {
          const e = new Error("tmux failed") as Error & { code: number; killed: boolean; signal: null; stderr: string };
          e.code = 1;
          e.killed = false;
          e.signal = null;
          e.stderr = "server exited unexpectedly\n";
          throw e;
        }
        return { dead: false, status: null };
      },
    };
    const runner = new SignInRunner({
      terminal,
      homes: new AccountHomes({ home, bins: { claude: FAKE, cursor: FAKE }, claudePool: null }),
      bins: { claude: FAKE, cursor: FAKE },
      now: () => Date.now(),
    });
    const started = await runner.start({ id: "si-tmux-err", runtime: "cursor", account: "main", create: false });
    expect(started.ok).toBe(true);
    expect(calls).toBeGreaterThan(1);
  });
});
