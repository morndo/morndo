// The board's copy of the hub's job list (design §7). A row keeps the list fields and drops the tail.
import { describe, expect, it } from "vitest";
import { chipOpensJob, decodeJob, decodeJobs, jobKey, jobsOn } from "../src/lib/desktop/jobs.ts";

describe("the job list", () => {
  it("keeps the list fields and drops the tail", () => {
    const job = decodeJob({
      id: "job-1", node: "pc", lane: "builder", name: "pack", class: "default", state: "exited",
      outcome: "exited", exit: 1, durationSec: 2, notice: "pending", task: "T-1", tail: "secret-tail", command: "npm test",
    });
    expect(job).toEqual({
      id: "job-1", node: "pc", lane: "builder", name: "pack", class: "default", state: "exited",
      outcome: "exited", exit: 1, durationSec: 2, notice: "pending", task: "T-1",
    });
    expect(job).not.toHaveProperty("tail");
    expect(job).not.toHaveProperty("command");
    expect(decodeJobs([job, { id: "no" }]).dropped).toBe(1);
  });

  it("puts a job chip on the task it names, and nowhere else", () => {
    const jobs = [
      { id: "job-1", node: "pc", lane: "builder", name: "pack", class: "default", state: "running", outcome: null, exit: null, durationSec: null, notice: "none", task: "T-1" },
      { id: "job-2", node: "pc", lane: "builder", name: "lint", class: "default", state: "exited", outcome: "exited", exit: 0, durationSec: 1, notice: "commented", task: "T-2" },
    ];
    expect(jobsOn("T-1", jobs).map(j => [j.name, j.state])).toEqual([["pack", "running"]]);
    expect(jobsOn("T-9", jobs)).toEqual([]);
  });

  it("names a chip by node and id, so two nodes can share an id", () => {
    expect(jobKey({ node: "pc", id: "build" })).toBe("pc:build");
    expect(jobKey({ node: "mac", id: "build" })).not.toBe(jobKey({ node: "pc", id: "build" }));
  });

  it("treats Enter and Space on a chip as opening the job", () => {
    expect(chipOpensJob("Enter")).toBe(true);
    expect(chipOpensJob(" ")).toBe(true);
    expect(chipOpensJob("Tab")).toBe(false);
  });
});
