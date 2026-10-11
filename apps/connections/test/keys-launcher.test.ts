import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { helperCommand, keysLauncher } from "../src/adapters/runtime-claude.ts";
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
});
