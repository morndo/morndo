import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Flight, HOLD_MAX_AGE_MS, HoldWatch, holdFile, productVersion, readHold } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const dir = () => { const d = mkdtempSync(join(tmpdir(), "hold-")); dirs.push(d); return d; };

const hold = (over: Record<string, unknown> = {}) => JSON.stringify({
  services: ["hub"], reason: "drain", version: "0.0.0", since: "2026-10-11T08:00:00.000Z", ...over,
});

describe("productVersion", () => {
  it("is the root package.json version", () => {
    expect(productVersion()).toBe("0.0.0");
  });
});

describe("readHold", () => {
  const now = Date.parse("2026-10-11T08:00:00.000Z");
  it("holds this service when the file is fresh, and allows work when the file is missing", () => {
    const home = dir();
    const path = join(home, "hold.json");
    expect(readHold({ path, service: "hub", now })).toEqual({ kind: "absent" });
    writeFileSync(path, hold());
    expect(readHold({ path, service: "hub", now }).kind).toBe("held");
  });
  it("ignores a hold older than 10 minutes, another service, and a file that does not fit", () => {
    const path = join(dir(), "hold.json");
    writeFileSync(path, hold({ since: new Date(now - HOLD_MAX_AGE_MS - 1).toISOString() }));
    expect(readHold({ path, service: "hub", now })).toEqual({ kind: "ignored", why: "stale" });
    writeFileSync(path, hold({ since: new Date(now - HOLD_MAX_AGE_MS).toISOString() }));
    expect(readHold({ path, service: "hub", now }).kind).toBe("held");
    writeFileSync(path, hold({ since: new Date(now + 60_000).toISOString() }));
    expect(readHold({ path, service: "hub", now })).toEqual({ kind: "ignored", why: "stale" });
    writeFileSync(path, hold({ services: ["fleet"] }));
    expect(readHold({ path, service: "hub", now })).toEqual({ kind: "ignored", why: "other-service" });
    writeFileSync(path, "{");
    expect(readHold({ path, service: "hub", now })).toEqual({ kind: "ignored", why: "malformed" });
  });
  it("keeps a test off the account's XDG state directory", () => {
    const home = "/tmp/morndo-test-home";
    const path = holdFile(home, { NODE_ENV: "test", HOME: home, XDG_STATE_HOME: "/tmp/account-state" });
    expect(path).toBe(join(home, ".local/state/morndo-update/hold.json"));
  });
});

describe("HoldWatch", () => {
  it("reports a stale hold once, until the file is fresh or gone", () => {
    const path = join(dir(), "hold.json");
    let t = Date.parse("2026-10-11T08:20:00.000Z");
    writeFileSync(path, hold({ since: "2026-10-11T08:00:00.000Z" }));
    const notes: string[] = [];
    const watch = new HoldWatch({ path, service: "hub", now: () => t, onStale: message => notes.push(message) });
    watch.refresh();
    watch.refresh();
    expect(watch.held).toBe(false);
    expect(notes).toHaveLength(1);
    writeFileSync(path, hold({ since: "2026-10-11T08:20:00.000Z" }));
    watch.refresh();
    expect(watch.held).toBe(true);
    t += HOLD_MAX_AGE_MS + 1;
    watch.refresh();
    expect(notes).toHaveLength(2);
    watch.stop();
  });
});

describe("HoldWatch onChange", () => {
  it("is told when the service starts and stops seeing the hold, and only then", () => {
    const path = join(dir(), "hold.json");
    const t = Date.parse("2026-10-11T08:20:00.000Z");
    const seen: boolean[] = [];
    const watch = new HoldWatch({ path, service: "hub", now: () => t, onChange: held => seen.push(held) });
    watch.refresh();
    writeFileSync(path, hold({ since: "2026-10-11T08:20:00.000Z" }));
    watch.refresh();
    watch.refresh();
    rmSync(path);
    watch.refresh();
    expect(seen).toEqual([true, false]);
    watch.stop();
  });
});

describe("Flight", () => {
  it("is idle at once when nothing is running, and waits for what is", async () => {
    const flight = new Flight();
    await flight.idle();
    const end = flight.begin({ kind: "pane.send", id: "hub:1" });
    expect(flight.list()).toEqual([{ kind: "pane.send", id: "hub:1" }]);
    let idle = false;
    const waiting = flight.idle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    end();
    await waiting;
  });
  it("returns when the wait is bounded, even if work is still running", async () => {
    const flight = new Flight();
    const end = flight.begin({ kind: "pane.send", id: "stuck" });
    const started = performance.now();
    await flight.idle(30);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(flight.list()).toHaveLength(1);
    end();
    expect(flight.list()).toEqual([]);
  });
  it("calls onChange after an item begins and after it ends, with the list already moved", () => {
    const sizes: number[] = [];
    const flight = new Flight({ onChange: () => sizes.push(flight.list().length) });
    const end = flight.begin({ kind: "pane.send", id: "hub:1" });
    expect(sizes).toEqual([1]);
    end();
    end();                                            // a second end of the same item changes nothing
    expect(sizes).toEqual([1, 0]);
  });
});
