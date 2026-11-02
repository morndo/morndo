import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Encrypter } from "age-encryption";
import { describe, expect, it } from "vitest";
import { AccountHomes } from "../src/signin/homes.ts";
import { SignInRunner } from "../src/signin/runner.ts";
import type { SignInTerminal } from "../src/signin/terminal.ts";

const FAKE = join(import.meta.dirname, "../../../test/fixtures/fake-signin-cli.mjs");
const SCREEN = "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=s1\nPaste code here if prompted > ";

describe("sign-in credentials file mode", () => {
  it("chmods a too-open .credentials.json to 0600 and still finishes done", async () => {
    const home = mkdtempSync(join(tmpdir(), "signin-mode-home-"));
    const dir = join(home, ".claude-accounts", "m1");
    let alive = true;
    const terminal: SignInTerminal = {
      open: async () => {},
      screen: async () => SCREEN,
      type: async () => {},
      enter: async () => {},
      close: async () => {},
      exit: async () => ({ dead: !alive, status: alive ? null : 0 }),
    };
    const runner = new SignInRunner({
      terminal,
      homes: new AccountHomes({ home, bins: { claude: FAKE, cursor: FAKE }, claudePool: null }),
      bins: { claude: FAKE, cursor: FAKE },
      now: () => Date.now(),
    });
    const started = await runner.start({ id: "si-mode", runtime: "claude", account: "m1", create: true });
    if (!started.ok) throw new Error(started.error.message);
    const e = new Encrypter();
    e.addRecipient(started.result.recipient!);
    await runner.code({ id: "si-mode", sealed: Buffer.from(await e.encrypt("good-code")).toString("base64") });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "x", refreshToken: "y", subscriptionType: "max" } }));
    chmodSync(join(dir, ".credentials.json"), 0o644);
    alive = false;
    const st = await runner.status({ id: "si-mode" });
    if (!st.ok) throw new Error(st.error.message);
    expect(st.result.phase).toBe("done");
    expect((existsSync(join(dir, ".credentials.json")))).toBe(true);
  });
});
