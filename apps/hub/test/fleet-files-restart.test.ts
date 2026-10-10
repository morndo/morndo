// A hub restart keeps what the fleet copies (ADR-0006: "An index keeps a copy reachable after the original is gone").
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileStore } from "../src/adapters/files.ts";
import { localNode, memoryBackend } from "./helpers/fake-fleet.ts";
import { fleetRig, type FleetRig } from "./helpers/hub-mode.ts";

const PC1 = "pc.aaaaaaaa.1";
const PATH = "/tmp/scratch/report.pdf";
const REPORT = Buffer.from("%PDF-1.7 synthetic report");
let dir = "";
const rigs: FleetRig[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("copies across a hub restart", () => {
  it("a file gone from its node still has its copy; an unchanged one is not read again", async () => {
    dir = mkdtempSync(join(tmpdir(), "files-restart-"));
    const files: Record<string, Uint8Array> = { [PATH]: REPORT };
    const pc = memoryBackend({ "%1": { name: "alpha", cwd: "/w/alpha", screen: "──────\n❯ " } }, { files });
    const start = async () => {
      const store = fileStore({ dir: join(dir, "files"), deny: [] });
      const rig = await fleetRig([localNode("pc", "aaaaaaaa", pc)], { files: store });
      rigs.push(rig);
      return { rig, store };
    };
    const first = await start();
    const copy = await first.rig.ports.files.register(PC1, PATH);
    expect(copy.id).toMatch(/^[0-9a-f]{32}$/);
    await first.rig.close(); rigs.pop();
    // restart 1: the file is unchanged on the node
    const second = await start();
    const reads = second.rig.fleet.fileReads.length;
    expect(await second.rig.ports.files.register(PC1, PATH)).toEqual(copy);
    expect(second.rig.fleet.fileReads.length).toBe(reads);              // not streamed again
    await second.rig.close(); rigs.pop();
    // restart 2: the file is gone from the node
    delete files[PATH];
    const third = await start();
    expect(await third.rig.ports.files.register(PC1, PATH)).toEqual(copy);
    expect(third.store.get(copy.id ?? "")).not.toBeNull();
  }, 30_000);
});
