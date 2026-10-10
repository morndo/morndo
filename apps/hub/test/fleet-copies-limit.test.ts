// The hub copies at most a few files of one node at a time, so the fleet's bulk queue (1 running + 8 waiting, spec §5.2)
// never refuses one busy; every file named at once is copied.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileStore } from "../src/adapters/files.ts";
import { localNode, memoryBackend } from "./helpers/fake-fleet.ts";
import { fleetRig, type FleetRig } from "./helpers/hub-mode.ts";

const PC1 = "pc.aaaaaaaa.1";
let dir = "";
let rig: FleetRig | null = null;
afterEach(async () => { await rig?.close(); rig = null; if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("copies of one node at once", () => {
  it("12 files named together all copy, with at most 4 streams open on the node", async () => {
    dir = mkdtempSync(join(tmpdir(), "copies-limit-"));
    const paths = Array.from({ length: 12 }, (_, i) => `/w/alpha/shots/${i}.png`);
    const files = Object.fromEntries(paths.map((p, i) => [p, Buffer.alloc(300_000, i + 1)]));   // two chunks each
    const pc = memoryBackend({ "%1": { name: "alpha", cwd: "/w/alpha", screen: "──────\n❯ " } }, { files });
    rig = await fleetRig([localNode("pc", "aaaaaaaa", pc)], { files: fileStore({ dir: join(dir, "files"), deny: [] }) });
    const open = new Set<string>();
    let widest = 0;
    // The streams open on the node: the fake fleet serves GET /v1/files outside fleet.intercept, so each stream the hub
    // reads (FleetClient.fileStream) is counted from its start to its end.
    const client = rig.client;
    const stream = client.fileStream.bind(client);
    client.fileStream = async function* (node: string, path: string) {
      open.add(path);
      widest = Math.max(widest, open.size);
      try { await new Promise(r => setTimeout(r, 15)); yield* stream(node, path); }
      finally { open.delete(path); }
    };
    const out = await Promise.all(paths.map(p => rig!.ports.files.register(PC1, p)));
    expect(out.filter(c => c.id === null)).toEqual([]);
    expect(widest).toBeLessThanOrEqual(4);
    expect(widest).toBeGreaterThan(1);                 // negative control: the copies do overlap, the limit is not 1
  }, 30_000);
});
