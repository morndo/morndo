import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AccountHomes } from "../src/signin/homes.ts";
import { SignInRunner } from "../src/signin/runner.ts";
import { tmuxTerminal } from "../src/signin/terminal.ts";

const FAKE = join(import.meta.dirname, "../../../test/fixtures/fake-signin-cli.mjs");
const SOCKET = `signin-cur-unk-${process.pid}`;
const bins = { claude: FAKE, cursor: FAKE };

describe("sign-in cursor status unreadable", () => {
  let home = "";
  let runner: SignInRunner;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "signin-cur-unk-home-"));
    const garbage = join(home, "garbage-cursor.mjs");
    writeFileSync(garbage, "#!/usr/bin/env node\nprocess.stdout.write('not a status\\n');\n");
    chmodSync(garbage, 0o755);
    runner = new SignInRunner({
      terminal: tmuxTerminal(SOCKET),
      homes: new AccountHomes({ home, bins, claudePool: null }),
      bins: { claude: FAKE, cursor: garbage },
      now: () => Date.now(),
    });
  });

  it("refuses cursor sign-in when agent status cannot be read", async () => {
    const started = await runner.start({ id: "si-cur-unk", runtime: "cursor", account: "main", create: false });
    expect(started.ok ? null : [started.error.code, started.error.message]).toEqual(["not_allowed", "cursor_status_unknown"]);
  });
});
