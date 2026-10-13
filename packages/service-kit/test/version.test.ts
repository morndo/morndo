import { describe, expect, it } from "vitest";
import { argvWantsVersion } from "../src/version.ts";

describe("argvWantsVersion", () => {
  it("is true only when --version is the first argument, before --", () => {
    expect(argvWantsVersion(["node", "morndo-keys", "--version"])).toBe(true);
    expect(argvWantsVersion(["node", "morndo-hub", "--version", "extra"])).toBe(true);
    expect(argvWantsVersion(["node", "morndo-keys", "run", "--connection", "work", "--", "claude", "--version"])).toBe(false);
    expect(argvWantsVersion(["node", "morndo-job", "start", "--", "npm", "--version"])).toBe(false);
    expect(argvWantsVersion(["node", "morndo-board", "comment", "T-12", "--version"])).toBe(false);
    expect(argvWantsVersion(["node", "morndo-hub", "--", "--version"])).toBe(false);
  });
});
