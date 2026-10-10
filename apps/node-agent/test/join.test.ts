// `morndo-node join` against a scripted fleet (spec §5.1; plan Review Focus 5): a join string pasted with whitespace,
// quotes or a trailing newline is accepted; a truncated one, a refused code or an unreachable fleet gives a clear error
// and leaves nothing on disk.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join as joinPath } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatJoinString, parseJoinString } from "@morndo/protocol";
import { loadConfig } from "../src/config.ts";
import { loadNodeKey } from "../src/identity.ts";
import { JoinError, join } from "../src/join.ts";
import { agentPaths } from "../src/paths.ts";
import { startFakeFleet, type FakeFleet } from "./fake-fleet.ts";
import { tempHome } from "./helpers.ts";

let fleet: FakeFleet;
const homes: { cleanup: () => void }[] = [];
beforeEach(async () => { fleet = await startFakeFleet(); });
afterEach(async () => { await fleet.close(); for (const h of homes.splice(0)) h.cleanup(); });
function home() { const h = tempHome(); homes.push(h); return h.home; }
// Nothing of the agent's on disk: no config or state directory at all.
const untouched = (h: string) => !existsSync(joinPath(h, ".config")) && !existsSync(joinPath(h, ".local"));

describe("join", () => {
  for (const [label, wrap] of [
    ["as printed", (s: string) => s],
    ["with spaces around it", (s: string) => `   ${s}  `],
    ["in double quotes", (s: string) => `"${s}"`],
    ["in single quotes with a trailing newline", (s: string) => `'${s}'\n`],
    ["with a trailing CRLF and a tab", (s: string) => `\t${s}\r\n`],
  ] as const) {
    it(`accepts a join string ${label}`, async () => {
      const h = home();
      const joined = await join({ home: h, joinString: wrap(fleet.joinString("pc")) });
      expect(joined).toMatchObject({ node: "pc", fleetUrl: fleet.url });
      const config = loadConfig(h);
      expect(config).toMatchObject({ node: "pc", fleetUrl: fleet.url, fleetKey: fleet.fleetKey, relayPort: 8787 });
      // The key the fleet was given is the key on disk, and only this user can read it.
      const sent = fleet.received.find(r => r.msg.t === "join")?.msg;
      expect(sent).toMatchObject({ v: 1, t: "join", node: "pc", proto: [1], agent: { version: "0.0.0" } });
      expect(sent?.publicKey).toBe(loadNodeKey(config.keyPath).publicKey);
      expect(statSync(config.keyPath).mode & 0o777).toBe(0o600);
      expect(statSync(agentPaths(h).configFile).mode & 0o777).toBe(0o600);
      expect(existsSync(agentPaths(h).policyFile)).toBe(true);
      expect(readdirSync(agentPaths(h).configDir).filter(f => f.endsWith(".tmp"))).toEqual([]);
    });
  }

  it("refuses a truncated join string with a clear error and writes nothing (and never dials)", async () => {
    const full = fleet.joinString("pc");
    for (const cut of [full.slice(0, -5), full.slice(0, 20), "morndo-join:1:", ""]) {
      const h = home();
      await expect(join({ home: h, joinString: cut })).rejects.toThrow(/not a complete join string.*Nothing was written/s);
      expect(untouched(h)).toBe(true);
    }
    expect(fleet.connections()).toBe(0);
  });

  it("writes nothing when the fleet refuses the code (4403), and says why", async () => {
    const h = home();
    const s = fleet.joinString("pc");
    await join({ home: home(), joinString: s });                       // the code is single use: this spends it
    await expect(join({ home: h, joinString: s })).rejects.toThrow(/refused the code.*Nothing was written/s);
    expect(untouched(h)).toBe(true);
  });

  it("writes nothing when the join string's name was changed: the code is bound to the name it was issued for", async () => {
    const issued = parseJoinString(fleet.joinString("pc"));
    if (!issued) throw new Error("the fake fleet's join string does not parse");
    const h = home();
    await expect(join({ home: h, joinString: formatJoinString({ ...issued, node: "other" }) })).rejects.toThrow(/refused the code.*Nothing was written/s);
    expect(untouched(h)).toBe(true);
  });

  it("refuses a plain ws:// fleet URL to another machine before dialing it, and writes nothing (plan Contracts, fleetUrlOk)", async () => {
    // ws://0.0.0.0:<port> reaches this machine's fake fleet if dialed, but its host is not a loopback name: no TLS, so
    // to the agent it is another machine.
    const port = Number(new URL(fleet.url).port);
    const plain = fleet.joinString("pc").replace(/^morndo-join:1:(.*)$/, (_, b64: string) => {
      const j = JSON.parse(Buffer.from(b64, "base64url").toString()) as Record<string, string>;
      return `morndo-join:1:${Buffer.from(JSON.stringify({ ...j, url: `ws://0.0.0.0:${port}/agent` })).toString("base64url")}`;
    });
    const h = home();
    await expect(join({ home: h, joinString: plain })).rejects.toThrow(/plain ws:\/\/ to another machine.*Nothing was written/s);
    expect(untouched(h)).toBe(true);
    expect(fleet.connections()).toBe(0);
  });

  it("writes nothing when the fleet can't be reached", async () => {
    const port = await new Promise<number>(resolve => {
      const srv = createServer().listen(0, "127.0.0.1", () => {
        const a = srv.address();
        srv.close(() => resolve(typeof a === "object" && a ? a.port : 0));
      });
    });
    const h = home();
    const closed = fleet.joinString("pc").replace(/^morndo-join:1:(.*)$/, (_, b64: string) => {
      const j = JSON.parse(Buffer.from(b64, "base64url").toString()) as Record<string, string>;
      return `morndo-join:1:${Buffer.from(JSON.stringify({ ...j, url: `ws://127.0.0.1:${port}/agent` })).toString("base64url")}`;   // a valid string, pointed at a closed port
    });
    await expect(join({ home: h, joinString: closed })).rejects.toThrow(JoinError);
    await expect(join({ home: h, joinString: closed })).rejects.toThrow(/Could not reach the fleet.*Nothing was written/s);
    expect(untouched(h)).toBe(true);
  });

  it("refuses to join twice and leaves the first join as it was", async () => {
    const h = home();
    await join({ home: h, joinString: fleet.joinString("pc") });
    const before = readFileSync(agentPaths(h).configFile, "utf8");
    await expect(join({ home: h, joinString: fleet.joinString("other") })).rejects.toThrow(/already joined/);
    expect(readFileSync(agentPaths(h).configFile, "utf8")).toBe(before);
  });

  it("keeps a policy.json the owner wrote before joining", async () => {
    const h = home();
    const p = agentPaths(h);
    mkdirSync(p.configDir, { recursive: true });
    writeFileSync(p.policyFile, JSON.stringify({ session: "lanes" }));
    await join({ home: h, joinString: fleet.joinString("pc") });
    expect(loadConfig(h).policy.session).toBe("lanes");
  });
});
