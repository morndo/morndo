// The web harness's own cleanup: the Vite cache dir startWeb makes is gone when startup fails, and close() can be called twice.
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWeb } from "./harness.ts";

let base = "";
const saved = process.env.TMPDIR;
afterEach(() => {
  vi.restoreAllMocks();
  if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
  if (base) rmSync(base, { recursive: true, force: true });
  base = "";
});

// A TMPDIR of the test's own, so what startWeb leaves is the only thing in it.
const ownTmp = () => {
  base = mkdtempSync(join(tmpdir(), "morndo-harness-test-"));
  process.env.TMPDIR = base;
};

describe("startWeb", () => {
  it("removes the Vite cache dir when the browser does not start", async () => {
    ownTmp();
    vi.spyOn(chromium, "launch").mockRejectedValue(new Error("no browser here"));
    await expect(startWeb()).rejects.toThrow("no browser here");
    expect(readdirSync(base).filter(name => name.startsWith("morndo-web-test-vite-"))).toEqual([]);
  }, 60_000);

  it("removes its dir on close, and a second close changes nothing", async () => {
    ownTmp();
    const web = await startWeb();
    expect(readdirSync(base).filter(name => name.startsWith("morndo-web-test-vite-"))).toHaveLength(1);
    await web.close();
    await web.close();
    expect(existsSync(base) ? readdirSync(base).filter(name => name.startsWith("morndo-web-test-vite-")) : []).toEqual([]);
  }, 60_000);
});
