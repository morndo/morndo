import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AccountHomes } from "../src/signin/homes.ts";
import { SignInRunner } from "../src/signin/runner.ts";
import { tmuxTerminal } from "../src/signin/terminal.ts";

const FAKE = join(import.meta.dirname, "../../../test/fixtures/fake-signin-cli.mjs");
const SOCKET = `signin-main-${process.pid}`;
const bins = { claude: FAKE, cursor: FAKE };

describe("sign-in refuse main create", () => {
  let home = "";
  let runner: SignInRunner;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "signin-main-home-"));
    runner = new SignInRunner({
      terminal: tmuxTerminal(SOCKET),
      homes: new AccountHomes({ home, bins, claudePool: null }),
      bins,
      now: () => Date.now(),
    });
  });

  it("refuses create:true for the main Claude account", async () => {
    const out = await runner.start({ id: "si-main-new", runtime: "claude", account: "main", create: true });
    expect(out.ok ? null : [out.error.code, out.error.message]).toEqual(["bad_args", "bad_account"]);
  });
});
