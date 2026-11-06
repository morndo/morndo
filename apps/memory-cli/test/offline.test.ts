// Which commands need no settings, decided from the CLI's own dispatch (see apps/board-cli/test/offline.test.ts).
import { describe, expect, it } from "vitest";
import { runsOffline } from "../src/cli.ts";

describe("morndo-memory runsOffline", () => {
  it("is true for no command, help, the help flag and a command it does not know (a usage line, no hub)", () => {
    for (const argv of [[], ["help"], ["search", "--help"], ["frobnicate"]]) expect(runsOffline(argv), argv.join(" ")).toBe(true);
  });
  it("is false for the commands that call the hub, whatever a flag's value or a positional looks like", () => {
    for (const argv of [["search", "x"], ["--kind", "help", "search", "x"], ["remember", "--kind", "fact", "--body", "-h", "--title", "t"], ["show", "N-1"]]) expect(runsOffline(argv), argv.join(" ")).toBe(false);
  });
});
