import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OpName } from "@morndo/protocol";
import { ALL_OPS } from "../src/config.ts";
import { openAgentDb } from "../src/db/open.ts";
import { captureLog } from "./helpers.ts";
import { DoneKeys } from "../src/ops/done-keys.ts";
import { OpExecutor, ok, read } from "../src/ops/executor.ts";
import { signinOps } from "../src/ops/signin-ops.ts";
import { AccountHomes } from "../src/signin/homes.ts";
import { SignInRunner } from "../src/signin/runner.ts";
import type { SignInTerminal } from "../src/signin/terminal.ts";

const FAKE = join(import.meta.dirname, "../../../test/fixtures/fake-signin-cli.mjs");
const SCREEN = "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=s1\nPaste code here if prompted > ";

describe("signin.start done keys", () => {
  it("stores no sign-in link or recipient on disk after a keyed start", async () => {
    const home = mkdtempSync(join(tmpdir(), "signin-keys-home-"));
    const terminal: SignInTerminal = {
      open: async () => {},
      screen: async () => SCREEN,
      type: async () => {},
      enter: async () => {},
      close: async () => {},
      exit: async () => ({ dead: false, status: null }),
    };
    const runner = new SignInRunner({
      terminal,
      homes: new AccountHomes({ home, bins: { claude: FAKE, cursor: FAKE }, claudePool: null }),
      bins: { claude: FAKE, cursor: FAKE },
      now: () => Date.now(),
    });
    const adb = openAgentDb(join(mkdtempSync(join(tmpdir(), "signin-keys-db-")), "agent.db"));
    const doneKeys = new DoneKeys(adb.db);
    const ops = {
      "inventory.get": read(async () => ok<"inventory.get">({ panes: [], invVersion: 0 })),
      ...signinOps(runner),
    };
    const ex = new OpExecutor({
      ops,
      allowed: new Set<OpName>(ALL_OPS),
      doneKeys,
      invVersion: () => 0,
      log: captureLog().log,
    });
    const key = "hub:signin-1";
    const args = { id: "si-keys", runtime: "claude" as const, account: "k1", create: true };
    const first = await ex.handle({ id: "1", op: "signin.start", args, timeoutMs: 30_000, key });
    expect(first.ok).toBe(true);
    const row = adb.db.prepare("SELECT outcome FROM done_keys WHERE key = ?").get(key) as { outcome: string };
    expect(row.outcome).not.toContain("claude.com");
    expect(row.outcome).not.toContain("age1");
    expect(row.outcome).not.toMatch(/recipient/);
    const again = await ex.handle({ id: "2", op: "signin.start", args, timeoutMs: 30_000, key });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.result).toMatchObject({ link: expect.stringContaining("claude.com") });
  });
});
