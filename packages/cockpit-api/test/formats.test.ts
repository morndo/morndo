import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { loadFixtures, validate } from "../src/index.ts";

describe("schema formats", () => {
  it("refuses an int64 outside the safe integer range and does not warn", () => {
    const usage = loadFixtures("gtm").find((file) => file.path === "usage.json");
    expect(usage).toBeDefined();
    const over = structuredClone(usage?.value) as { subscriptions: { lanes: number; meters: { used: number }[] }[] };
    const first = over.subscriptions[0];
    expect(first).toBeDefined();
    if (!first) return;
    first.lanes = Number.MAX_SAFE_INTEGER + 1;
    const refused = validate("UsageView", over);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.errors.join("\n")).toMatch(/int64|format/);

    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { loadFixtures, validate } from "./packages/cockpit-api/src/index.ts";
      const usage = loadFixtures("gtm").find((file) => file.path === "usage.json");
      if (!usage) throw new Error("missing usage");
      const ok = validate("UsageView", usage.value);
      const copy = structuredClone(usage.value);
      copy.subscriptions[0].lanes = Number.MAX_SAFE_INTEGER + 1;
      const bad = validate("UsageView", copy);
      console.log(JSON.stringify({ ok: ok.ok, bad: bad.ok }));
    `], { encoding: "utf8" });
    expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
    expect(child.stderr).not.toMatch(/unknown format/);
    expect(JSON.parse(child.stdout)).toEqual({ ok: true, bad: false });
  });
});
