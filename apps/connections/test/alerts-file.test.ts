// An alert is a log line (secret-store README §4). A later process, including the page, reads the ones already written.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileAlerts } from "../src/adapters/alerts-file.ts";
import { openHome } from "../src/compose.ts";

const catalog = join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("alerts on disk", () => {
  it("a new process lists alerts an earlier run raised", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-alerts-"));
    dirs.push(dir);
    const path = join(dir, "alerts.log");
    new FileAlerts(path).raise({ kind: "drift", name: "implement", detail: "changed outside" });
    const home = openHome({ ...process.env, MORNDO_CONNECTIONS_HOME: dir, MORNDO_VAULT: "file", MORNDO_CATALOG: catalog });
    try {
      expect(home.commands.page().alerts).toEqual([{ kind: "connection", name: "implement", detail: "Changed outside Morndo" }]);
    } finally { home.close(); }
  });

  it("keeps newest first, drops the oldest at the cap, and skips one bad line", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-alerts-"));
    dirs.push(dir);
    const path = join(dir, "alerts.log");
    const first = new FileAlerts(path);
    for (let i = 0; i < 20; i++) first.raise({ kind: "drift", name: `a${i}`, detail: "d" });
    const second = new FileAlerts(path);
    second.raise({ kind: "drift", name: "new", detail: "d" });
    expect(second.recent().map(alert => alert.name)).toEqual(["new", ...Array.from({ length: 19 }, (_, i) => `a${19 - i}`)]);
    const torn = join(dir, "torn.log");
    writeFileSync(torn, `${JSON.stringify({ kind: "drift", name: "old", detail: "d" })}\n{not-json\n${JSON.stringify({ kind: "drift", name: "fresh", detail: "d" })}\n`);
    const loaded = new FileAlerts(torn);
    expect(loaded.recent().map(alert => alert.name)).toEqual(["fresh", "old"]);
    expect(loaded.skipped).toBe(1);
  });
});
