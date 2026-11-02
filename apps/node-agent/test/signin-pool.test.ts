// The node finds the pool tool on PATH without a shell, and reads which accounts the pool has retired or let expire, so
// those get no card (ADR-0039). A stand-in `claude-pool` prints the pool's JSON lines.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { onPath } from "../src/signin/path.ts";
import { AccountHomes } from "../src/signin/homes.ts";
import { SignInRunner } from "../src/signin/runner.ts";
import { tmuxTerminal } from "../src/signin/terminal.ts";

const FAKE = join(import.meta.dirname, "../../../test/fixtures/fake-signin-cli.mjs");

describe("the pool tool on a node", () => {
  it("is found on PATH as an executable file, never through a shell built-in", () => {
    const bin = mkdtempSync(join(tmpdir(), "pool-bin-"));
    const tool = join(bin, "claude-pool");
    writeFileSync(tool, "#!/bin/sh\nexit 0\n");
    chmodSync(tool, 0o755);
    writeFileSync(join(bin, "not-executable"), "x");
    expect(onPath("claude-pool", { PATH: `/nonexistent:${bin}` })).toBe(tool);
    expect(onPath("not-executable", { PATH: bin })).toBe(null);
    expect(onPath("claude-pool", { PATH: "/nonexistent" })).toBe(null);
  });

  it("marks accounts the pool retired or let expire, and none it keeps", async () => {
    const home = mkdtempSync(join(tmpdir(), "pool-home-"));
    for (const a of ["a1", "a4", "a5", "a6"]) mkdirSync(join(home, ".claude-accounts", a), { recursive: true });
    const bin = mkdtempSync(join(tmpdir(), "pool-bin-"));
    const tool = join(bin, "claude-pool");
    const lines = [
      { name: "main", retired: "", expires: null }, { name: "a1", retired: "", expires: null },
      { name: "a4", retired: "retired by hand", expires: null }, { name: "a5", retired: "", expires: "2020-01-01" },
      { name: "a6", retired: "", expires: "2999-01-01" },
    ].map(l => JSON.stringify(l)).join("\\n");
    writeFileSync(tool, `#!/bin/sh\n[ "$1" = list ] && printf '${lines}\\n'\n`);
    chmodSync(tool, 0o755);
    const bins = { claude: FAKE, cursor: FAKE };
    const runner = new SignInRunner({ terminal: tmuxTerminal(`pool-test-${process.pid}`), homes: new AccountHomes({ home, bins, claudePool: tool }), bins, now: () => Date.now() });
    const listed = await runner.accounts({ runtime: "claude" });
    if (!listed.ok) throw new Error(listed.error.message);
    expect(Object.fromEntries(listed.result.accounts.map(a => [a.name, a.retired]))).toEqual({ main: false, a1: false, a4: true, a5: true, a6: false });
  });
});
