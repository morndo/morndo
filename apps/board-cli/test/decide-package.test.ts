// board-cli depends on the shared brief template. It does not import the hub's source.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("morndo-decide's package", () => {
  it("depends on the shared protocol package and does not import the hub", () => {
    const src = readFileSync(new URL("../src/decide.ts", import.meta.url), "utf8");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies?: Record<string, string> };
    expect(src).not.toContain("apps/hub");
    expect(src).not.toContain("../../hub/");
    expect(src).toContain("@morndo/protocol");
    expect(pkg.dependencies?.["@morndo/protocol"]).toBe("0.0.0");
  });
});
