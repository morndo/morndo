// `morndo-fleet serve` as a process: it reports where agents connect only once it listens, a node joined with
// `node add` connects to it, and SIGTERM stops it cleanly (exit 0). Temp HOME and config; port 0.
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJoinString } from "@morndo/protocol";
import { FakeAgent } from "./helpers/fake-agent.ts";
import { tempDir } from "./helpers/temp.ts";

const MAIN = join(import.meta.dirname, "../src/main.ts");

describe("morndo-fleet serve", () => {
  it("listens, takes a joined node, and stops on SIGTERM with exit 0", async () => {
    const home = tempDir();
    const config = join(home, "fleet.json");
    writeFileSync(config, JSON.stringify({ listen: { host: "127.0.0.1", port: 0 }, socketPath: join(home, "s", "f.sock") }));
    const env = { ...process.env, HOME: home, MORNDO_FLEET_CONFIG: config };
    const added = spawnSync(process.execPath, ["--no-warnings", MAIN, "node", "add", "pc"], { env, encoding: "utf8", timeout: 20_000 });
    const joinString = parseJoinString(added.stdout.split("\n").find(l => l.startsWith("morndo-join:")) ?? "");
    expect(joinString).not.toBeNull();
    const child = spawn(process.execPath, ["--no-warnings", MAIN, "serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let out = "";
        child.stdout.on("data", (d: Buffer) => { out += d.toString(); const m = /agents on (ws:\/\/127\.0\.0\.1:\d+\/agent)/.exec(out); if (m?.[1]) resolve(m[1]); });
        child.once("exit", code => reject(new Error(`serve exited with ${code}`)));
      });
      const agent = new FakeAgent({ url, fleetKey: joinString?.fleetKey ?? "" });
      expect(joinString?.node).toBe("pc");
      expect((await agent.join(joinString?.node ?? "", joinString?.code ?? "")).welcome).toMatchObject({ t: "welcome" });
      expect((await agent.connect()).ok).toBe(true);
      const exited = new Promise<number | null>(r => child.once("exit", code => r(code)));
      child.kill("SIGTERM");
      expect(await exited).toBe(0);
      expect((await agent.closed).code).toBe(1001);                                    // "fleet service stopping"
    } finally { child.kill("SIGKILL"); }
  }, 30_000);
});
