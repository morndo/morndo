// At start the node agent clears what an earlier run left of its sign-ins (ADR-0039). With no sign-in tmux server to
// kill, which is the usual case, tmux fails, and that failure must not be an unhandled rejection: the agent exits on one
// (seen: "unhandled promise rejection; exiting ... tmux -L morndo-signin kill-server: no server running").
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reconcileSignInLeftovers } from "../src/signin/leftover-homes.ts";

describe("clearing sign-in leftovers at start", () => {
  it("finds no tmux server to kill and raises nothing", async () => {
    const seen: unknown[] = [];
    const listener = (e: unknown) => { seen.push(e); };
    process.on("unhandledRejection", listener);
    try {
      const home = mkdtempSync(join(tmpdir(), "leftover-home-"));
      reconcileSignInLeftovers({ stateDir: join(home, "state"), agentHome: home, tmuxSocket: `no-such-server-${process.pid}` });
      await new Promise(r => setTimeout(r, 1500));
    } finally {
      process.off("unhandledRejection", listener);
    }
    expect(seen).toEqual([]);
  });
});
