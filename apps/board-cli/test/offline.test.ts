// Which commands need no settings, decided from each CLI's own command dispatch (the parsed command word and its flags),
// not from scanning the arguments: a flag's value or the child command of a job can look like a help request.
import { describe, expect, it } from "vitest";
import { runsOffline as boardOffline } from "../src/cli.ts";
import { runsOffline as decideOffline } from "../src/decide.ts";

describe("morndo-board runsOffline", () => {
  it("is true for no command, help, prompt and the help flag, whatever flags come first", () => {
    for (const argv of [[], ["help"], ["prompt", "--role", "worker"], ["--role", "worker", "prompt"], ["show", "T-1", "--help"], ["--json", "help"]]) expect(boardOffline(argv), argv.join(" ")).toBe(true);
  });
  it("is false for every command that calls the hub, whatever a flag's value or a positional looks like", () => {
    for (const argv of [["show", "T-1"], ["--json", "show", "T-1"], ["comment", "T-12", "-h"], ["--lane", "help", "list"], ["done", "T-1", "--why", "help"]]) expect(boardOffline(argv), argv.join(" ")).toBe(false);
  });
});

describe("morndo-decide runsOffline", () => {
  it("is true for help, template, prompt, lint, a card template and the help flag", () => {
    for (const argv of [[], ["help"], ["template"], ["prompt", "--role", "worker"], ["lint", "f.md"], ["card", "--template"], ["show", "x", "--help"]]) expect(decideOffline(argv), argv.join(" ")).toBe(true);
  });
  it("is false for the commands that call the hub", () => {
    for (const argv of [["show", "dr-1"], ["new", "f.md"], ["card", "f.md"], ["--kind", "help", "show", "x"]]) expect(decideOffline(argv), argv.join(" ")).toBe(false);
  });
});
