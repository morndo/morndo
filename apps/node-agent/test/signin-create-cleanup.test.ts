import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Encrypter } from "age-encryption";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AccountHomes } from "../src/signin/homes.ts";
import { SignInRunner } from "../src/signin/runner.ts";
import { tmuxTerminal } from "../src/signin/terminal.ts";

const FAKE = join(import.meta.dirname, "../../../test/fixtures/fake-signin-cli.mjs");
const SOCKET = `signin-cleanup-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const bins = { claude: FAKE, cursor: FAKE };

const seal = async (recipient: string, code: string) => {
  const e = new Encrypter();
  e.addRecipient(recipient);
  return Buffer.from(await e.encrypt(code)).toString("base64");
};

async function untilFinished(runner: SignInRunner, id: string) {
  const end = Date.now() + 15_000;
  for (;;) {
    const s = await runner.status({ id });
    if (!s.ok) throw new Error(s.error.message);
    if (s.result.phase !== "waiting" && s.result.phase !== "checking") return s.result;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise(r => setTimeout(r, 150));
  }
}

describe("sign-in create home cleanup", () => {
  let home = "";
  let clock = Date.now();
  let runner: SignInRunner;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "signin-cleanup-home-"));
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

  it("removes a create:true home after a wrong code, then allows create again", async () => {
    const dir = join(home, ".claude-accounts", "a9");
    const started = await runner.start({ id: "si-a9", runtime: "claude", account: "a9", create: true });
    if (!started.ok) throw new Error(started.error.message);
    expect(existsSync(dir)).toBe(true);
    await runner.code({ id: "si-a9", sealed: await seal(started.result.recipient!, "wrong-code") });
    expect((await untilFinished(runner, "si-a9")).phase).toBe("failed");
    expect(existsSync(dir)).toBe(false);
    expect((await runner.start({ id: "si-a9b", runtime: "claude", account: "a9", create: true })).ok).toBe(true);
  });

  it("removes a create:true home on cancel", async () => {
    const dir = join(home, ".claude-accounts", "a8");
    expect((await runner.start({ id: "si-a8", runtime: "claude", account: "a8", create: true })).ok).toBe(true);
    expect(existsSync(dir)).toBe(true);
    expect((await runner.cancel({ id: "si-a8" })).ok).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it("leaves the home when create:false fails", async () => {
    const dir = join(home, ".claude-accounts", "a7");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
    const started = await runner.start({ id: "si-a7", runtime: "claude", account: "a7", create: false });
    if (!started.ok) throw new Error(started.error.message);
    await runner.code({ id: "si-a7", sealed: await seal(started.result.recipient!, "wrong-code") });
    expect((await untilFinished(runner, "si-a7")).phase).toBe("failed");
    expect(existsSync(dir)).toBe(true);
  });

  it("removes a create:true home after expiry when reap runs", async () => {
    const dir = join(home, ".claude-accounts", "a6");
    expect((await runner.start({ id: "si-a6", runtime: "claude", account: "a6", create: true })).ok).toBe(true);
    expect(existsSync(dir)).toBe(true);
    clock += 10 * 60_000 + 1;
    await runner.reap();
    expect(existsSync(dir)).toBe(false);
  });
});
