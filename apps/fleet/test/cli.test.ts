// The console: `node add` prints a join string that carries the configured URL, the fleet's public key, the node's
// name and a code that registers exactly that node; `node list`, `node revoke` and `status` work with no service
// running. Real processes, a temp HOME and config, no service.
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJoinString } from "@morndo/protocol";
import { openFleetDb } from "../src/adapters/db.ts";
import { loadOrCreateFleetKey } from "../src/adapters/keys.ts";
import { NodesStore } from "../src/adapters/nodes-store.ts";
import { Audit } from "../src/adapters/audit.ts";
import { tempDir } from "./helpers/temp.ts";

const MAIN = join(import.meta.dirname, "../src/main.ts");

function setup() {
  const home = tempDir();
  const config = join(home, "fleet.json");
  writeFileSync(config, JSON.stringify({ publicUrl: "wss://fleet.example.test/agent", socketPath: join(home, "run", "f.sock") }));
  const run = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", MAIN, ...args], {
    env: { ...process.env, HOME: home, MORNDO_FLEET_CONFIG: config }, encoding: "utf8", timeout: 20_000,
  });
  const dbPath = join(home, ".local/share/morndo-fleet/fleet.db");
  return { home, run, dbPath, keyPath: join(home, ".local/share/morndo-fleet/fleet-key.pem") };
}
const spki = () => generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");

describe("morndo-fleet console", { timeout: 30_000 }, () => {
  it("node add: a join string with the public URL, the fleet's key and a code bound to the name", () => {
    const { run, dbPath, keyPath } = setup();
    const r = run("node", "add", "pc");
    expect(r.status, r.stderr).toBe(0);
    const line = r.stdout.split("\n").find(l => l.startsWith("morndo-join:1:")) ?? "";
    const j = parseJoinString(line);
    expect(j).not.toBeNull();
    expect(j?.url).toBe("wss://fleet.example.test/agent");
    expect(j?.node).toBe("pc");
    expect(j?.fleetKey).toBe(loadOrCreateFleetKey(keyPath).publicKey);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    const db = openFleetDb(dbPath);
    const nodes = new NodesStore(db);
    expect(nodes.redeem(j?.code ?? "", "pc", spki())).toEqual({ ok: true, node: "pc" });
    expect(new Audit(db).of("node.add").map(a => [a.actor, a.node])).toEqual([["cli", "pc"]]);
    expect(JSON.stringify(new Audit(db).recent())).not.toContain(j?.code ?? "");   // the code is never audited
    db.close();
  });

  it("node add refuses a bad name with exit 2 and writes nothing", () => {
    const { run, dbPath } = setup();
    const r = run("node", "add", "My PC");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/a node name is 1 to 32/);
    expect(() => statSync(dbPath)).toThrow();
  });

  it("node add refuses a registered node until it is revoked", () => {
    const { run, dbPath } = setup();
    const first = parseJoinString(run("node", "add", "pc").stdout.split("\n").find(l => l.startsWith("morndo-join:")) ?? "");
    const db = openFleetDb(dbPath);
    new NodesStore(db).redeem(first?.code ?? "", "pc", spki());
    db.close();
    const again = run("node", "add", "pc");
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/revoke it first/);
  });

  it("node list and node revoke work without the service, and say when the revocation applies", () => {
    const { run, dbPath } = setup();
    const j = parseJoinString(run("node", "add", "pc").stdout.split("\n").find(l => l.startsWith("morndo-join:")) ?? "");
    const db = openFleetDb(dbPath);
    new NodesStore(db).redeem(j?.code ?? "", "pc", spki());
    db.close();
    expect(run("node", "list").stdout).toMatch(/^pc\s+active /m);
    const r = run("node", "revoke", "pc");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/revoked pc; the fleet service did not answer/);
    expect(run("node", "list").stdout).toMatch(/^pc\s+REVOKED /m);
    expect(run("node", "revoke", "pc").status).toBe(1);
    const after = openFleetDb(dbPath);
    expect(new Audit(after).of("node.revoke").map(a => a.node)).toEqual(["pc"]);
    after.close();
  });

  it("status says the service is not reachable, with exit 1", () => {
    const { run } = setup();
    const r = run("status");
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/NOT REACHABLE/);
    expect(r.stdout).toMatch(/alerts in the last 24 h: none/);
  });

  it("help for no command, exit 2 for an unknown one", () => {
    const { run } = setup();
    expect(run().status).toBe(0);
    expect(run().stdout).toMatch(/node add <name>/);
    expect(run("frobnicate").status).toBe(2);
  });
});
