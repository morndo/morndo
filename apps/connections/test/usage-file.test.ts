// Subscription usage windows come from the connections home, through compose, on the page the hub reads.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Actor } from "@morndo/domain";
import { openHome } from "../src/compose.ts";

const who: Actor = { kind: "principal", command: "c1" };
const catalog = join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("usage windows", () => {
  it("compose shows the usage file on the subscription the page lists", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-usage-"));
    dirs.push(dir);
    writeFileSync(join(dir, "usage.json"), JSON.stringify({ "sub-a": { fiveHour: 12, sevenDay: 40 } }));
    const env: NodeJS.ProcessEnv = { ...process.env, MORNDO_CONNECTIONS_HOME: dir, MORNDO_VAULT: "file", MORNDO_CATALOG: catalog };
    delete env.MORNDO_ENGINES_BIN;
    const home = openHome(env);
    try {
      expect(home.connections.addSubscription({ name: "sub-a", vendor: "claude", runtime: "claude", configDir: "/cfg" }, who).ok).toBe(true);
      const row = home.commands.page().connections.find(item => item.name === "sub-a");
      expect(row?.usageFiveHour).toBe(12);
      expect(row?.usageSevenDay).toBe(40);
    } finally { home.close(); }
  });
});
