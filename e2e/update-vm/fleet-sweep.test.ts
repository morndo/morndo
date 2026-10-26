// The two-machine run's sweep (fleet-sweep.ts, review of #116): at its start a run removes only what a gone run of its
// own kind left — containers, the network, the build scratch — never a live run's, and never #109's (morndo-c2-e2e).
// A fake docker records every call; a fake /proc says which runs live.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeOwnedScratch } from "./checks.ts";
import { FLEET_LABEL, FLEET_OWNER_LABEL, ownerLabels, sweepFleetLeftovers } from "./fleet-sweep.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const dir = () => { const d = mkdtempSync(join(tmpdir(), "morndo-fleet-sweep-")); dirs.push(d); return d; };
const fakeProc = (live: Record<number, string>) => {
  const root = dir();
  for (const [pid, started] of Object.entries(live)) {
    mkdirSync(join(root, pid));
    const fields = ["S", "1", "1", "1", "0", "-1", "4194560", "0", "0", "0", "0", "0", "0", "0", "0", "20", "0", "1", "0", started, "1000", "100"];
    writeFileSync(join(root, pid, "stat"), `${pid} (node) ${fields.join(" ")}\n`);
  }
  return root;
};
// A docker that answers `ps` and `network ls` with the given rows ("<id> <owner>") and records every call.
const fakeDocker = (rows: { containers: string[]; networks: string[] }) => {
  const calls: string[][] = [];
  const docker = (args: string[]) => {
    calls.push(args);
    if (args[0] === "ps") return { code: 0, out: rows.containers.join("\n"), err: "" };
    if (args[0] === "network" && args[1] === "ls") return { code: 0, out: rows.networks.join("\n"), err: "" };
    return { code: 0, out: "", err: "" };
  };
  return { docker, calls };
};

describe("the two-machine run's sweep", () => {
  it("removes a gone run's containers and network, keeps a live run's, and takes an unowned one for a gone run's", () => {
    const proc = fakeProc({ 4242: "777" });                          // the run still going
    const { docker, calls } = fakeDocker({
      containers: ["c-live 4242:777", "c-gone 5555:1", "c-old "],
      networks: ["n-live 4242:777", "n-gone 5555:1"],
    });
    const said: string[] = [];
    const out = sweepFleetLeftovers({ docker, say: l => said.push(l), keep: false, tmp: dir(), procRoot: proc });
    expect(out.containers).toEqual(["c-gone", "c-old"]);
    expect(out.networks).toEqual(["n-gone"]);
    const removed = calls.filter(c => c[0] === "rm" || (c[0] === "network" && c[1] === "rm")).map(c => c.at(-1));
    expect(removed).toEqual(["c-gone", "c-old", "n-gone"]);         // containers first, then the network
    expect(said.some(l => l.includes("network a gone run left behind (n-gone)"))).toBe(true);
  });

  it("asks docker by its own label only, and never names #109's", () => {
    const { docker, calls } = fakeDocker({ containers: [], networks: [] });
    sweepFleetLeftovers({ docker, say: () => {}, keep: false, tmp: dir(), procRoot: fakeProc({}) });
    for (const c of calls) expect(c.join(" ")).not.toContain("morndo-c2");
    expect(calls.filter(c => c.includes(`label=${FLEET_LABEL}`))).toHaveLength(2);
  });

  it("removes only a gone fleet run's build scratch: a live one's, and #109's, stay", () => {
    const tmp = dir();
    const proc = fakeProc({ 4242: "777" });
    const live = makeOwnedScratch(tmp, "4242:777", { prefix: "morndo-fleet" });
    const gone = makeOwnedScratch(tmp, "5555:1", { prefix: "morndo-fleet" });
    const c2 = makeOwnedScratch(tmp, "5555:1");                      // #109's, of a gone run: its own run sweeps it
    const out = sweepFleetLeftovers({ docker: fakeDocker({ containers: [], networks: [] }).docker, say: () => {}, keep: false, tmp, procRoot: proc });
    expect(out.scratch).toEqual([gone.split("/").at(-1)]);
    expect([existsSync(live), existsSync(gone), existsSync(c2)]).toEqual([true, false, true]);
  });

  it("labels a run's things with its kind and its owner", () => {
    expect(ownerLabels("4242:777")).toEqual(["--label", `${FLEET_LABEL}=1`, "--label", `${FLEET_OWNER_LABEL}=4242:777`]);
  });
});
