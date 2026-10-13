import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { helperCommand, keysLauncher, keysProgram } from "../src/adapters/runtime-claude.ts";
import { helperParts } from "../src/adapters/runtime-codex.ts";

describe("keys launcher", () => {
  it("is the stable launcher, not a version's own file", () => {
    const home = "/srv/person";
    const launcher = keysLauncher(home);
    expect(launcher).toBe(join(home, ".local/bin/morndo-keys"));
    const command = helperCommand(launcher, "lease-1");
    expect(command).toBe(`${launcher} helper --lease lease-1`);
    expect(command.includes("main.ts")).toBe(false);
    expect(command.includes("--experimental-strip-types")).toBe(false);
    expect(helperParts(launcher, "lease-1")).toEqual({ command: launcher, args: ["helper", "--lease", "lease-1"] });
  });
  it("uses a configured absolute path, and never a relative path when HOME is unset", () => {
    expect(keysLauncher("", "/opt/morndo/morndo-keys")).toBe("/opt/morndo/morndo-keys");
    const unset = keysLauncher("");
    expect(isAbsolute(unset)).toBe(true);
    expect(unset.startsWith(".")).toBe(false);
    expect(keysLauncher("", "morndo-keys")).toBe("/usr/local/bin/morndo-keys");
  });
  it("uses this program when the installed launcher is missing", () => {
    const self = { command: "/usr/bin/node", args: ["--experimental-strip-types", "/opt/morndo/main.ts"] };
    expect(keysProgram("/srv/person", undefined, () => false, self)).toEqual(self);
    expect(keysProgram("", undefined, () => false, self)).toEqual(self);
    expect(keysProgram("/srv/person", undefined, () => true, self)).toEqual({
      command: join("/srv/person", ".local/bin/morndo-keys"), args: [],
    });
  });
});
