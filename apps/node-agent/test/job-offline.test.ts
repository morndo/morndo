// Which `morndo job` calls need no settings: those that print the usage. A -h or --help in the job's own command is the
// job's, not a request for help.
import { describe, expect, it } from "vitest";
import { runsOffline } from "../src/job-cli.ts";

describe("morndo-job runsOffline", () => {
  it("is true for no command, a word that is no command, and the help flags", () => {
    for (const argv of [[], ["--help"], ["-h"], ["help"], ["frobnicate"]]) expect(runsOffline(argv), argv.join(" ")).toBe(true);
  });
  it("is false for start and the reads, whatever the job's own command carries", () => {
    for (const argv of [["start", "--notify", "fleet", "--", "ls", "-h", "/tmp"], ["start", "--notify", "fleet", "--", "grep", "--help"], ["list"], ["show", "job:1"], ["logs", "job:1"], ["cancel", "job:1"]]) expect(runsOffline(argv), argv.join(" ")).toBe(false);
  });
});
