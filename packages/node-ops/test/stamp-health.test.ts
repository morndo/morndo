// The tmux server stamp and the health probe (docs/design/fleet-core/README.md §4, §5.4), on an isolated tmux server and
// a temporary home.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { healthProbe, memAvailableFrom, psiFrom } from "../src/health.ts";
import { stampServer } from "../src/stamp.ts";
import { isolatedTmux, type TestTmux } from "./isolated-tmux.ts";

let t: TestTmux;
beforeEach(() => { t = isolatedTmux(); });
afterEach(() => t.kill());
const stored = () => t.tmux("show-options", "-gqv", "@morndo-server").trim();

describe("stampServer", () => {
  it("is null without a server, stamps a server once, and a restarted server gets a new stamp", async () => {
    expect(await stampServer(t.socket)).toBeNull();
    t.tmux("new-session", "-d", "-s", "main", "sleep 600");
    const first = await stampServer(t.socket);
    expect(first).toMatch(/^[0-9a-f]{8}$/);
    expect(stored()).toMatch(new RegExp(`^${first}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`));
    expect(await stampServer(t.socket)).toBe(first);
    await t.kill();
    t.tmux("new-session", "-d", "-s", "main", "sleep 600");
    expect(await stampServer(t.socket)).not.toBe(first);
  });
  it("two callers on a fresh server agree on one stamp", async () => {
    t.tmux("new-session", "-d", "-s", "main", "sleep 600");
    const [a, b] = await Promise.all([stampServer(t.socket), stampServer(t.socket)]);
    expect(a).toBe(b);
    expect(stored().slice(0, 8)).toBe(a);
  });
  it("keeps a stamp that is already there", async () => {
    t.tmux("new-session", "-d", "-s", "main", "sleep 600");
    t.tmux("set-option", "-g", "@morndo-server", "0a1b2c3d-0000-4000-8000-000000000000");
    expect(await stampServer(t.socket)).toBe("0a1b2c3d");
  });
});

describe("healthProbe", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "morndo-health-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  it("reports memory, disk and load as numbers, and whether the node's tmux server answers", async () => {
    const h = await healthProbe(home, { tmuxSocket: t.socket });
    expect(Object.keys(h).sort()).toEqual(["diskFreeHome", "load1", "memAvailable", "memTotal", "psiFull10", "psiSome10", "tmuxOk"]);
    expect(h.memTotal).toBeGreaterThan(0);
    expect(h.memAvailable).toBeGreaterThan(0);
    expect(h.memAvailable).toBeLessThanOrEqual(h.memTotal);
    expect(h.diskFreeHome).toBeGreaterThan(0);
    expect(h.load1).toBeGreaterThanOrEqual(0);
    for (const p of [h.psiSome10, h.psiFull10]) expect(p === null || p >= 0).toBe(true);
    expect(h.tmuxOk).toBe(false);                                     // no server on this socket yet
    t.tmux("new-session", "-d", "-s", "main", "sleep 600");
    expect((await healthProbe(home, { tmuxSocket: t.socket })).tmuxOk).toBe(true);
  });
  it("reads /proc's MemAvailable and the PSI 10-second averages", () => {
    expect(memAvailableFrom("MemTotal:       16000000 kB\nMemAvailable:    8000000 kB\n")).toBe(8_000_000 * 1024);
    expect(memAvailableFrom("MemTotal: 1 kB\n")).toBeNull();
    expect(psiFrom("some avg10=1.50 avg60=0.20 avg300=0.00 total=123\nfull avg10=0.25 avg60=0.00 avg300=0.00 total=4\n")).toEqual({ some10: 1.5, full10: 0.25 });
    expect(psiFrom("some avg10=3.00 avg60=0.00 avg300=0.00 total=1\n")).toEqual({ some10: 3, full10: null });
  });
});
