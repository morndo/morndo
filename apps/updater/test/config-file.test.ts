// The update settings file (design §8.3) and the updater's paths (§5): defaults when there is no file, every field
// when there is one, and a file that isn't the wire's shape refused by name. A window crosses midnight as minutes
// of the local day, its end below its start.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigFile, ConfigInvalid } from "../src/adapters/config-file.ts";
import { updaterPaths } from "../src/adapters/paths.ts";

let scratch = "";
beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "morndo-upd-")); });
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

describe("the update settings file (§8.3)", () => {
  const file = () => join(scratch, "config.json");
  const write = (body: string) => writeFileSync(file(), body, "utf8");

  it("no file: the defaults, and reading it twice changes nothing", () => {
    const source = new ConfigFile(join(scratch, "absent.json"));
    expect(source.read()).toEqual({ channel: "stable", mode: "apply", pin: null, window: null, soakMinutes: null });
    expect(source.read()).toEqual({ channel: "stable", mode: "apply", pin: null, window: null, soakMinutes: null });
  });
  it("a full file: every field, the window minutes and the pin a parsed Version", () => {
    write(`${JSON.stringify({ channel: "latest", mode: "stage", window: "22:00-06:00", pin: "1.2.3-rc.1" }, null, 2)}\n`);
    expect(new ConfigFile(file()).read()).toEqual({
      channel: "latest", mode: "stage", window: { start: 1320, end: 360 },
      pin: { major: 1, minor: 2, patch: 3, pre: ["rc", "1"], build: null },
      soakMinutes: null,                       // absent in the file: the domain's default, kept as null
    });
  });
  it("a soak the file names rides along (§4.5): the commit's state record carries it to the fleet", () => {
    write(`${JSON.stringify({ soakMinutes: 45 })}\n`);
    expect(new ConfigFile(file()).read()).toMatchObject({ soakMinutes: 45 });
  });
  it("a window that wraps midnight keeps end below start (22:00-06:00 is 1320 to 360)", () => {
    write(`${JSON.stringify({ window: "22:00-06:00" })}\n`);
    expect(new ConfigFile(file()).read().window).toEqual({ start: 1320, end: 360 });
    write(`${JSON.stringify({ window: "02:00-06:00" })}\n`);
    expect(new ConfigFile(file()).read().window).toEqual({ start: 120, end: 360 });
  });
  it("a file that isn't JSON is refused naming its path", () => {
    write("not json at all");
    const read = () => new ConfigFile(file()).read();
    expect(read).toThrow(ConfigInvalid);
    expect(read).toThrow(/config\.json/);
  });
  it("a file that isn't the wire's shape is refused naming its path", () => {
    for (const bad of [{ window: "25:00-06:00" }, { mode: "auto" }, { extra: true }]) {
      write(JSON.stringify(bad));
      const read = () => new ConfigFile(file()).read();
      expect(read, JSON.stringify(bad)).toThrow(ConfigInvalid);
      expect(read).toThrow(file());
    }
  });
});

describe("the updater's paths (§5)", () => {
  it("everything hangs off HOME: data under share, state under state, config under config", () => {
    expect(updaterPaths("/srv/example-user")).toEqual({
      releases: "/srv/example-user/.local/share/morndo-releases",
      state: "/srv/example-user/.local/state/morndo-update",
      db: "/srv/example-user/.local/state/morndo-update/update.db",
      lock: "/srv/example-user/.local/state/morndo-update/apply.lock",
      downloads: "/srv/example-user/.local/state/morndo-update/downloads",
      config: "/srv/example-user/.config/morndo-update/config.json",
    });
  });
  it("a home that isn't absolute is refused, whatever it says it is", () => {
    expect(() => updaterPaths("example")).toThrow();
    expect(() => updaterPaths("")).toThrow();
    expect(() => updaterPaths(".")).toThrow();
  });
});
