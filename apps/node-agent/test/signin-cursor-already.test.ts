import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AccountHomes } from "../src/signin/homes.ts";
import { SignInRunner } from "../src/signin/runner.ts";
import { tmuxTerminal } from "../src/signin/terminal.ts";

const FAKE = join(import.meta.dirname, "../../../test/fixtures/fake-signin-cli.mjs");
const SOCKET = `signin-cursor-${process.pid}`;
const bins = { claude: FAKE, cursor: FAKE };

describe("sign-in cursor already signed in", () => {
  let home = "";
  let runner: SignInRunner;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "signin-cursor-home-"));
    const cursorDir = join(home, ".config", "cursor");
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(join(cursorDir, "auth.json"), JSON.stringify({ accessToken: "fake-session" }));
    runner = new SignInRunner({
      terminal: tmuxTerminal(SOCKET),
      homes: new AccountHomes({ home, bins, claudePool: null }),
      bins,
      now: () => Date.now(),
    });
  });

  it("refuses to start cursor sign-in while already logged in", async () => {
    const started = await runner.start({ id: "si-cur-busy", runtime: "cursor", account: "main", create: false });
    expect(started.ok ? null : [started.error.code, started.error.message]).toEqual(["not_allowed", "already_signed_in"]);
  });
});
