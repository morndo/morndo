// The package's main entry is safe to import in a browser bundle: no import.meta.url and no
// new URL(...), which Vite turns into a glob over the whole package folder when the URL is a
// template literal (https://vite.dev/guide/assets, "new URL(url, import.meta.url)"). The Node
// helper for file URLs lives in the separate subpath @morndo/brand/node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = (f: string): string => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { exports: Record<string, string> };

describe("browser-safe entry", () => {
  it.each(["index.ts", "tokens.ts"])("src/%s uses no import.meta.url and no new URL()", f => {
    expect(src(f)).not.toMatch(/import\.meta\.url|new URL\(/);
  });
  it("exports the Node helper only from @morndo/brand/node", async () => {
    expect(pkg.exports["./node"]).toBe("./src/node.ts");
    const node = await import("../src/node.ts");
    expect(typeof node.brandAssetUrl).toBe("function");
  });
});
