import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Encrypter } from "age-encryption";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AccountHomes } from "../src/signin/homes.ts";
import { SignInRunner } from "../src/signin/runner.ts";
import { tmuxTerminal } from "../src/signin/terminal.ts";

const FAKE = join(import.meta.dirname, "../../../test/fixtures/fake-signin-cli.mjs");
const SOCKET = `signin-lost-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const bins = { claude: FAKE, cursor: FAKE };

const seal = async (recipient: string, code: string) => {
  const e = new Encrypter();
  e.addRecipient(recipient);
  return Buffer.from(await e.encrypt(code)).toString("base64");
};

describe("sign-in lost terminal", () => {
  let home = "";
  let runner: SignInRunner;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "signin-lost-home-"));
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

  it("returns accepted:false without throwing when the tmux session is gone", async () => {
    const started = await runner.start({ id: "si-lost", runtime: "claude", account: "a1", create: true });
    if (!started.ok) throw new Error(started.error.message);
    execFileSync("tmux", ["-L", SOCKET, "kill-session", "-t", "=si-lost"], { stdio: "ignore" });
    const sealed = await seal(started.result.recipient!, "good-code");
    const sent = await runner.code({ id: "si-lost", sealed });
    expect(sent).toEqual({ ok: true, result: { accepted: false } });
    const st = await runner.status({ id: "si-lost" });
    if (!st.ok) throw new Error(st.error.message);
    expect(st.result.phase).toBe("failed");
    expect(st.result.problem).toBe("node_lost");
    expect(JSON.stringify(sent)).not.toContain("good-code");
    expect(JSON.stringify(sent)).not.toContain(sealed);
  });
});
