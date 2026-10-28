// The adoption rehearsal's own judgements (adopt-checks.ts), tested without a machine.
import { describe, expect, it } from "vitest";
import { doctorVerdict, missingRows, runsFromLauncher, runsTree, sameListing, sameProcess, UNIT_MARK, unitAdopted } from "./adopt-checks.ts";

const LEGACY = "[Unit]\nDescription=Morndo node agent\n\n[Service]\nExecStart=%h/.nvm/versions/node/v24.0.0/bin/node --no-warnings %h/morndo/releases/abc1234/apps/node-agent/src/main.ts run\n";
const SHIPPED = `${UNIT_MARK}\n[Unit]\nDescription=Morndo node agent\n\n[Service]\nExecStart=%h/.local/bin/morndo-node run\n`;

describe("a unit adopted", () => {
  it("carries Morndo's mark and has the old file kept beside it", () => {
    expect(unitAdopted("morndo-node.service", SHIPPED, ["morndo-node.service", "morndo-node.service.before-morndo"]).ok).toBe(true);
  });
  it("is not adopted while the file is the old one, or the old file was not kept", () => {
    const old = unitAdopted("morndo-node.service", LEGACY, ["morndo-node.service", "morndo-node.service.before-morndo"]);
    expect(old.ok).toBe(false);
    expect(old.detail).toContain("mark");
    const unkept = unitAdopted("morndo-node.service", SHIPPED, ["morndo-node.service"]);
    expect(unkept.ok).toBe(false);
    expect(unkept.detail).toContain("before-morndo");
  });
});

describe("a unit that runs from the launcher", () => {
  it("is true for the shipped ExecStart and false for a release folder's main.ts", () => {
    expect(runsFromLauncher(SHIPPED)).toBe(true);
    expect(runsFromLauncher(LEGACY)).toBe(false);
    expect(runsFromLauncher("[Service]\nRestart=always\n")).toBe(false);
  });
});

describe("the same process", () => {
  it("needs the same pid and the same start time (a reused pid is another process)", () => {
    expect(sameProcess({ pid: 10, started: "500" }, { pid: 10, started: "500" }).ok).toBe(true);
    expect(sameProcess({ pid: 10, started: "500" }, { pid: 10, started: "900" }).ok).toBe(false);
    expect(sameProcess({ pid: 10, started: "500" }, { pid: 11, started: "500" }).ok).toBe(false);
    expect(sameProcess({ pid: 10, started: "500" }, null).ok).toBe(false);
    expect(sameProcess(null, null).ok).toBe(false);
  });
});

describe("the same listing", () => {
  const before = "apps/hub/src/main.ts 120\npackage.json 40\n";
  it("holds for the same paths and sizes in any order", () => {
    expect(sameListing(before, "package.json 40\napps/hub/src/main.ts 120\n").ok).toBe(true);
  });
  it("names the path that went, changed or appeared", () => {
    expect(sameListing(before, "package.json 40\n")).toMatchObject({ ok: false, detail: expect.stringContaining("apps/hub/src/main.ts") });
    expect(sameListing(before, "apps/hub/src/main.ts 121\npackage.json 40\n").detail).toContain("apps/hub/src/main.ts");
    expect(sameListing(before, `${before}extra.txt 1\n`).detail).toContain("extra.txt");
  });
  it("is not satisfied by two empty listings", () => {
    expect(sameListing("", "").ok).toBe(false);
  });
});

describe("rows kept", () => {
  it("lists the expected rows a database answer lacks, whole lines only", () => {
    expect(missingRows("lane-demo\nnode-demo\n", ["lane-demo", "node-demo"])).toEqual([]);
    expect(missingRows("lane-demo-2\n", ["lane-demo"])).toEqual(["lane-demo"]);
    expect(missingRows("", ["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("the doctor after a fresh install", () => {
  const clean = "ok: the install checks out\n";
  it("published mode: exit 0 and the clean line are a real check", () => {
    expect(doctorVerdict(true, 0, clean).ok).toBe(true);
    expect(doctorVerdict(true, 1, "tree: files.json: unreadable\n").ok).toBe(false);
    expect(doctorVerdict(true, 0, "").ok).toBe(false);
    expect(doctorVerdict(true, 1, clean).ok).toBe(false);
    expect(doctorVerdict(true, 1, "tree: files.json: unreadable\n").detail).toContain("exited 1");
  });
  it("local mode: always a finding (ok), with the word in the detail", () => {
    expect(doctorVerdict(false, 1, "tree: files.json: unreadable\n")).toEqual({ ok: true, detail: "doctor exited 1: tree: files.json: unreadable" });
    expect(doctorVerdict(false, 0, clean).ok).toBe(true);
  });
});

describe("which tree a process runs", () => {
  const old = "/srv/worker/.nvm/versions/node/v24.0.0/bin/node --no-warnings /srv/worker/morndo/releases/abc1234/apps/hub/src/main.ts serve";
  const fresh = "/srv/worker/.local/share/morndo-releases/versions/0.1.1/node/bin/node /srv/worker/.local/share/morndo-releases/versions/0.1.1/app/apps/hub/src/main.ts serve";
  it("tells the old folder from the installed version, which a version string cannot when both report the same one", () => {
    expect(runsTree("old", old)).toBe(true);
    expect(runsTree("new", old)).toBe(false);
    expect(runsTree("new", fresh)).toBe(true);
    expect(runsTree("old", fresh)).toBe(false);
    expect(runsTree("old", "(no main process)")).toBe(false);
    expect(runsTree("new", "(gone)")).toBe(false);
  });
});
