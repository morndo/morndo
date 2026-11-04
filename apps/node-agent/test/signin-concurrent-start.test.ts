import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AccountHomes } from "../src/signin/homes.ts";
import { SignInRunner } from "../src/signin/runner.ts";
import { tmuxTerminal } from "../src/signin/terminal.ts";

const FAKE = join(import.meta.dirname, "../../../test/fixtures/fake-signin-cli.mjs");
const SOCKET = `signin-busy-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const bins = { claude: FAKE, cursor: FAKE };

describe("sign-in concurrent start", () => {
  let home = "";
  let runner: SignInRunner;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "signin-busy-home-"));
    runner = new SignInRunner({
      terminal: tmuxTerminal(SOCKET),
      homes: new AccountHomes({ home, bins, claudePool: null }),
      bins,
      now: () => Date.now(),
    });
  });

  afterAll(() => {
    try { execFileSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" }); } catch { /* none left */ }
  });

  it("allows only one concurrent start per account", async () => {
    const [s1, s2] = await Promise.all([
      runner.start({ id: "si-c1", runtime: "claude", account: "a1", create: true }),
      runner.start({ id: "si-c2", runtime: "claude", account: "a1", create: false }),
    ]);
    const oks = [s1.ok, s2.ok].filter(Boolean).length;
    const busy = [s1, s2].filter(r => !r.ok && r.error.code === "busy").length;
    expect(oks).toBe(1);
    expect(busy).toBe(1);
  });
});
