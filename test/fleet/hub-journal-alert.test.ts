// The hub's own revocation journal at start (RL10, docs/design/updates/README.md §11.5), through the hub as it runs:
// a line it cannot read is skipped, the hub starts, and the app's feed carries the urgent journal_unreadable Alert —
// the same one the fleet raises for its own journal (apps/hub/src/main.ts wires it; this is that wiring's test).
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startFleet, startHub, stopAll, until } from "../fleet-harness.ts";

afterEach(async () => { await stopAll(); });

describe("the hub's revocation journal at start", () => {
  it("a garbage line starts the hub anyway, and the feed shows the urgent journal_unreadable Alert", async () => {
    const fleet = await startFleet();
    const hub = await startHub(fleet);
    await hub.restart({ whileStopped: async () => { appendFileSync(join(hub.home, "revoked.log"), "garbage that is no entry\n"); } });
    const feed = await hub.feed();
    const alert = await until("the journal_unreadable alert in the feed", () =>
      feed.alerts.find(a => a.kind === "journal_unreadable") ?? null, 20_000);
    expect(alert.detail).toMatchObject({ file: "revoked.log", line: 1 });
    expect(hub.log()).toMatch(/revoked\.log line 1 skipped/);
  });
});
