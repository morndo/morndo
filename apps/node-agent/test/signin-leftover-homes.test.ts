import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileSignInLeftovers, recordSignInCreatedHome } from "../src/signin/leftover-homes.ts";

const SOCKET = `signin-left-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

describe("sign-in leftover homes on restart", () => {
  let home = "";
  let stateDir = "";

  afterEach(() => {
    try { execFileSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" }); } catch { /* none */ }
  });

  it("drops recorded create homes without credentials and clears the record", () => {
    home = mkdtempSync(join(tmpdir(), "signin-left-home-"));
    stateDir = mkdtempSync(join(tmpdir(), "signin-left-state-"));
    const dir = join(home, ".claude-accounts", "z9");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
    recordSignInCreatedHome(stateDir, { runtime: "claude", account: "z9" });
    execFileSync("tmux", ["-L", SOCKET, "new-session", "-d", "-s", "orphan"], { stdio: "ignore" });
    reconcileSignInLeftovers({ stateDir, agentHome: home, tmuxSocket: SOCKET });
    expect(existsSync(dir)).toBe(false);
    expect(() => execFileSync("tmux", ["-L", SOCKET, "has-session"], { stdio: "ignore" })).toThrow();
    expect(readFileSync(join(stateDir, "signin-created-homes.json"), "utf8")).toBe("[]\n");
  });
});
