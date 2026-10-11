// `morndo lanes` (fleet-clients §9.2) as a person runs it: the real console, a child process, against the fake fleet on
// a real Unix socket, with a temporary HOME and no hub settings or database. Each command's output and exit code
// (0 accepted, 3 not delivered in time, 4 given up, refused or uncertain, 69 the fleet unavailable, 2 bad arguments).
// Synthetic panes only; never the owner's fleet socket.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LaneEvent } from "@morndo/protocol";
import { localNode, memoryBackend, refusal, until, type FakeFleet, type MemoryBackend } from "./helpers/fake-fleet.ts";
import { runLanes, type LanesIo } from "../src/console/lanes.ts";
import { startFakeFleet } from "./helpers/fake-fleet.ts";

const MAIN = join(import.meta.dirname, "../src/main.ts");
let home: string;
let fleet: FakeFleet;
let backend: MemoryBackend;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "morndo-lanes-"));
  backend = memoryBackend({
    "%0": { name: "manager", cwd: "/w/manager", screen: "one\ntwo\nthree\n❯ ", sessionId: "s-m", status: "busy", pid: 4242, topic: "Ship the release", lastPrompt: "check CI" },
    "%1": { name: "alpha", cwd: "/w/alpha", screen: "a1\na2\n❯ ", sessionId: "s-a", status: "idle", pid: 4343 },
    "%2": { name: "shell", cwd: "/w", screen: "$ " },
  });
  fleet = await startFakeFleet({ nodes: [localNode("pc", "aaaaaaaa", backend)] });
});
afterEach(async () => { await fleet.close(); rmSync(home, { recursive: true, force: true }); });

type Ran = { code: number | null; out: string; err: string };
// `morndo lanes …`; `stdin` is written and closed; `during` runs while it does (moving a delivery, say); once its output
// satisfies `interruptWhen`, it gets SIGINT, as from Ctrl-C.
function lanes(args: string[], o: { stdin?: string; env?: Record<string, string>; during?: () => Promise<void>; interruptWhen?: (out: string) => boolean; stopAfterMs?: number } = {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, MORNDO_FLEET_SOCKET: fleet.socketPath, ...o.env };
    const child = spawn(process.execPath, ["--no-warnings", MAIN, "lanes", ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const stop = o.stopAfterMs === undefined ? undefined : setTimeout(() => child.kill("SIGINT"), o.stopAfterMs);
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); if (o.interruptWhen?.(out)) child.kill("SIGINT"); });
    child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    child.stdin.end(o.stdin ?? "");
    child.on("error", reject);
    child.on("exit", code => { if (stop) clearTimeout(stop); resolve({ code, out, err }); });
    void o.during?.();
  });
}

describe("morndo lanes: listing and reading", () => {
  it("constructor and toString are not commands", async () => {
    const ctor = await lanes(["constructor"], { stopAfterMs: 3000 });           // a bound for a hang, past the CLI's own start
    expect(ctor.code, ctor.err).toBe(2);
    expect(ctor.err).toMatch(/no such lanes command: constructor/);
    const named = await lanes(["toString", "--json"]);
    expect(named.code, named.err).toBe(2);
    expect(named.err).toMatch(/no such lanes command: toString/);
  });

  it("lists every lane, with its node, worker id, session status, pid and folder", async () => {
    const r = await lanes([]);
    expect(r.code, r.err).toBe(0);
    const [head, ...rows] = r.out.trim().split("\n");
    expect(head).toMatch(/^NAME\s+NODE\s+WORKER\s+STATUS\s+PID\s+FOLDER\s+TITLE$/);
    expect(rows).toEqual([
      expect.stringMatching(/^alpha\s+pc\s+pc\.aaaaaaaa\.1\s+idle\s+4343\s+\/w\/alpha$/),
      expect.stringMatching(/^manager\s+pc\s+pc\.aaaaaaaa\.0\s+busy\s+4242\s+\/w\/manager\s+Ship the release$/),   // its topic
      expect.stringMatching(/^shell\s+pc\s+pc\.aaaaaaaa\.2\s+-\s+-\s+\/w$/),
    ]);
    expect(new Set(fleet.clients)).toEqual(new Set(["lanes"]));            // it names itself, for the fleet's audit
  });

  it("--json: each lane's fields, its session's topic and last prompt included (ruling 13)", async () => {
    const r = await lanes(["--json"]);
    expect(JSON.parse(r.out)).toContainEqual({ name: "manager", node: "pc", workerId: "pc.aaaaaaaa.0", window: "manager", status: "busy", pid: 4242,
      cwd: "/w/manager", title: null, topic: "Ship the release", lastPrompt: "check CI", sessionId: "s-m", online: true, conflict: false });
    expect(JSON.parse(r.out)).toContainEqual(expect.objectContaining({ name: "shell", topic: null, lastPrompt: null, status: null, pid: null }));
  });

  it("peek: the screen's last lines (default 40, --lines N)", async () => {
    expect((await lanes(["peek", "manager", "--lines", "2"])).out).toBe("three\n❯ \n");
    expect((await lanes(["peek", "manager"])).out).toBe("one\ntwo\nthree\n❯ \n");
    expect((await lanes(["peek", "manager", "--lines", "0"])).code).toBe(2);
    expect((await lanes(["peek", "nobody"])).code).toBe(4);
  });
});

describe("morndo lanes send", () => {
  it("queues a delivery and says where it stands; 0", async () => {
    const r = await lanes(["send", "manager", "status please"]);
    expect(r.code, r.err).toBe(0);
    const [call] = fleet.deliveryCalls;
    expect(call).toMatchObject({ lane: "manager", workerId: null, text: "status please", id: expect.stringMatching(/^lanes:[0-9a-f-]{36}$/) });
    expect(r.out).toBe(`${call?.id}: queued\n`);
  });

  it("- reads the text from stdin, without its last newline", async () => {
    expect((await lanes(["send", "manager", "-"], { stdin: "from stdin\n" })).code).toBe(0);
    expect(fleet.deliveryCalls[0]?.text).toBe("from stdin");
  });

  it("--id chooses it (lanes: added when it names no client); the same id again is the same delivery", async () => {
    expect((await lanes(["send", "manager", "once", "--id", "mine"])).out).toBe("lanes:mine: queued\n");
    expect((await lanes(["send", "manager", "once", "--id", "lanes:mine"])).code).toBe(0);
    expect(fleet.deliveries.size).toBe(1);
    expect((await lanes(["send", "manager", "other text", "--id", "lanes:mine"])).code).toBe(4);   // id_conflict
  });

  it("--wait: 0 once delivered, 3 if not in time, 4 if given up", async () => {
    const moveWhen = (state: "delivered" | "given_up") => async () => {
      await until(() => fleet.deliveryCalls.length > 0);
      const id = fleet.deliveryCalls.at(-1)?.id ?? "";
      fleet.moveDelivery(id, state === "delivered" ? { state, deliveredAt: Date.now() } : { state, why: "expired" });
    };
    const delivered = await lanes(["send", "manager", "a", "--wait", "5"], { during: moveWhen("delivered") });
    expect(delivered.code).toBe(0);
    expect(delivered.out).toMatch(/: delivered\n$/);
    expect((await lanes(["send", "manager", "b", "--wait", "0.5"])).code).toBe(3);
    fleet.deliveryCalls.length = 0;
    expect((await lanes(["send", "manager", "c", "--wait", "5"], { during: moveWhen("given_up") })).code).toBe(4);
  });

  it("--wait: an uncertain delivery (it may have reached the lane) is 4 (ruling 60)", async () => {
    const r = await lanes(["send", "manager", "maybe", "--wait", "5"], {
      during: async () => { await until(() => fleet.deliveryCalls.length > 0); fleet.moveDelivery(fleet.deliveryCalls[0]?.id ?? "", { state: "uncertain", note: "typed, never seen taken" }); },
    });
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/: uncertain\n$/);
  });

  it("an in-doubt refusal of the delivery (uncertain, it may have been stored) is 5 with the id", async () => {
    fleet.refuseDeliveries(1);
    const r = await lanes(["send", "manager", "text"]);
    const id = fleet.deliveryCalls[0]?.id ?? "";
    expect(r.code, r.err).toBe(5);
    expect(r.err).toContain(`in doubt: the fleet took ${id}`);
    expect(r.err).toContain(`--id ${id}`);
    expect(r.out).toBe("");
  });

  it("--wait: the fleet gone after queued is 5 with the id, not 69 (nothing was queued is only before the answer)", async () => {
    const r = await lanes(["send", "manager", "run tests", "--wait", "5"], {
      during: async () => { await until(() => fleet.deliveryCalls.length > 0); await fleet.close(); },
    });
    const id = fleet.deliveryCalls[0]?.id ?? "";
    expect(r.code, r.err).toBe(5);
    expect(r.err).toContain(`in doubt: the fleet took ${id}`);
    expect(r.err).not.toContain("nothing was asked of it");
  });

  // Review (fleet-clients branch) #4: once the delivery is queued, a poll answered by something that isn't the client API
  // (a proxy's page, a fleet of another version) is no proof that nothing was queued: exit 69 would invite a new id.
  it("--wait: a poll after queued answered by something that isn't the client API is 5 with the id, not 69", async () => {
    const sock = join(home, "skew.sock");
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString(); });
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/v1/deliveries") {
          const b = JSON.parse(body) as { id: string; lane: string };
          const at = Date.now();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, delivery: { id: b.id, node: "pc", target: { lane: b.lane }, state: "queued", queuedAt: at, notAfter: at + 60_000 } }));
          return;
        }
        res.writeHead(404, { "content-type": "text/html" });
        res.end("<html><body>Not Found</body></html>");                     // a proxy's page, not the fleet's JSON
      });
    });
    await new Promise<void>(resolve => server.listen(sock, () => resolve()));
    try {
      const r = await lanes(["send", "manager", "run tests", "--wait", "5", "--id", "w1"], { env: { MORNDO_FLEET_SOCKET: sock } });
      expect(r.code, r.err).toBe(5);
      expect(r.err).toContain("in doubt: the fleet took lanes:w1");
      expect(r.err).not.toContain("nothing was asked of it");
    } finally {
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    }
  });

  it("the fleet reached but silent (a timeout after the POST) is 5, in doubt; the same --id again is 0, one delivery (ruling 49)", { timeout: 30_000 }, async () => {
    fleet.loseDeliveryAnswers(1, "hang");
    const first = await lanes(["send", "manager", "deploy when green", "--id", "t1"]);
    expect(first.code).toBe(5);
    expect(first.err).toContain("in doubt: the fleet took lanes:t1 and never answered");
    expect(first.err).toContain("run it again with the same --id (--id lanes:t1)");
    expect(await lanes(["send", "manager", "deploy when green", "--id", "t1"])).toMatchObject({ code: 0, out: "lanes:t1: queued\n" });
    expect(fleet.deliveries.size).toBe(1);
  });

  it("--direct types at once, under its id as the key; a refusal is 4", async () => {
    const r = await lanes(["send", "shell", "ls", "--direct", "--id", "d1"]);
    expect(r.code, r.err).toBe(0);
    expect(backend.typed).toEqual([{ pane: "%2", text: "ls", key: "lanes:d1" }]);
    expect(fleet.deliveryCalls).toEqual([]);
    backend.panes["%1"] = { ...backend.panes["%1"]!, problem: "menu_open" };
    expect((await lanes(["send", "alpha", "x", "--direct"])).code).toBe(4);
  });

  it("the fleet not reached: 69, and nothing guessed (negative control)", async () => {
    const r = await lanes(["send", "manager", "x"], { env: { MORNDO_FLEET_SOCKET: join(home, "nothing.sock") } });
    expect(r.code).toBe(69);
    expect(r.err).toContain("the fleet couldn't be reached");                   // 69: never reached, so nothing was queued
    const d = await lanes([], { env: { MORNDO_FLEET_SOCKET: "" } });          // the default socket, under this HOME
    expect(d.code).toBe(69);
    expect(d.err).toContain(join(home, ".local/state/morndo-fleet/fleet.sock"));
  });
});

// Review (fleet-clients branch) #10: each online node's inventory is asked for at once, not one node after another, so
// one lane's name costs the slowest node's answer, not the sum of all of them.
describe("morndo lanes with several nodes", () => {
  it("asks every online node for its inventory at once", async () => {
    await fleet.close();
    const node = (name: string, server: string, window: string) => localNode(name, server, memoryBackend({ "%0": { name: window, cwd: `/w/${window}`, screen: `${window}\n❯ `, sessionId: `s-${window}` } }));
    fleet = await startFakeFleet({ nodes: [node("pc", "aaaaaaaa", "alpha"), node("mac", "bbbbbbbb", "beta"), node("box", "cccccccc", "gamma")] });
    const asked: number[] = [];
    fleet.intercept("inventory.get", async (_call, next) => { asked.push(Date.now()); await new Promise(r => setTimeout(r, 800)); return next(); });
    const lines: string[] = [];
    const io: LanesIo = { env: { HOME: home, MORNDO_FLEET_SOCKET: fleet.socketPath }, out: async t => { lines.push(t); }, err: async t => { lines.push(t); },
      stdin: async () => "", interrupted: () => new Promise<void>(() => {}) };
    expect(await runLanes(["peek", "gamma"], io), lines.join("\n")).toBe(0);
    expect(asked).toHaveLength(3);
    expect(Math.max(...asked) - Math.min(...asked)).toBeLessThan(400);       // one after another: 800 ms apart each
  });
});

describe("morndo lanes: keys, start, stop, status, events", () => {
  it("keys by name; a name not on the allow-list is 2, and nothing is sent", async () => {
    expect((await lanes(["keys", "alpha", "Escape", "Enter"])).code).toBe(0);
    expect(backend.keyNamesTyped).toEqual([{ pane: "%1", names: ["Escape", "Enter"] }]);
    expect((await lanes(["keys", "alpha", "F13"])).code).toBe(2);
    expect(backend.keyNamesTyped).toHaveLength(1);
  });

  it("start: lane.start on the one online node, with its folder, account and first prompt", async () => {
    fleet.intercept("lane.start", async () => ({ ok: true, result: { workerId: "pc.aaaaaaaa.9", prompt: "lanes:start:x:prompt" } }));
    const r = await lanes(["start", "build", "--cwd", "/w/build", "--account", "work", "--prompt", "go"]);
    expect(r.code, r.err).toBe(0);
    expect(fleet.calls.find(c => c.op === "lane.start")).toMatchObject({ node: "pc", args: { name: "build", cwd: "/w/build", account: "work", prompt: "go" }, key: expect.stringMatching(/^lanes:start:/) });
    const resume = "3f2c7a1e-9b4d-4e8a-a1c2-5d6e7f809a1b";                     // ruling 60: --resume reaches lane.start
    expect((await lanes(["start", "build", "--cwd", "/w/build", "--resume", resume])).code).toBe(0);
    expect(fleet.calls.filter(c => c.op === "lane.start").at(-1)?.args).toEqual({ name: "build", cwd: "/w/build", resume });
    expect(r.out).toContain("started build on pc: pc.aaaaaaaa.9");
    expect((await lanes(["start", "build"])).code).toBe(2);                    // no --cwd
    fleet.intercept("lane.start", async () => ({ ok: true, result: { workerId: "pc.aaaaaaaa.9", waiting: "trust" } }));
    const json = await lanes(["start", "build", "--cwd", "/w/build", "--json", "--node", "pc"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toEqual({ node: "pc", workerId: "pc.aaaaaaaa.9", waiting: "trust" });
  });

  it("stop: graceful by default, --kill closes the window; not seen to stop in time is 3, a refusal 4 (ruling 29)", async () => {
    fleet.intercept("lane.stop", async call => {
      const a = call.args as { name: string; mode: string };
      if (a.name === "manager") return refusal("denied", "protected");
      if (a.name === "shell" && a.mode === "exit") return refusal("uncertain", "after /exit the lane neither closed nor came back to its shell in time");
      return { ok: true, result: { ok: true } };
    });
    expect((await lanes(["stop", "alpha"])).code).toBe(0);
    expect((await lanes(["stop", "alpha", "--kill"])).code).toBe(0);
    expect(fleet.calls.filter(c => c.op === "lane.stop").map(c => c.args)).toEqual([{ name: "alpha", mode: "exit" }, { name: "alpha", mode: "kill" }]);
    const late = await lanes(["stop", "shell"]);
    expect(late.code).toBe(3);
    expect(late.err).toContain("refused: uncertain (it may have happened)");
    expect((await lanes(["stop", "shell", "--kill"])).code).toBe(0);          // --kill after an exit that timed out
    const denied = await lanes(["stop", "manager"]);
    expect(denied.code).toBe(4);
    expect(denied.err).toContain("refused: denied");                          // the refusal's code, on stderr
  });

  it("status: a delivery's state; given up or unknown is 4", async () => {
    await lanes(["send", "manager", "x", "--id", "s1"]);
    expect(await lanes(["status", "lanes:s1"])).toMatchObject({ code: 0, out: "lanes:s1: queued\n" });
    fleet.moveDelivery("lanes:s1", { state: "given_up", why: "cancelled" });
    expect(await lanes(["status", "lanes:s1"])).toMatchObject({ code: 4, out: "lanes:s1: given_up (cancelled)\n" });
    expect((await lanes(["status", "lanes:nope"])).code).toBe(4);
  });

  it("events: lane events as they happen, until interrupted; 0", async () => {
    const e: LaneEvent = { v: 1, t: "lane", seq: 1, event: "finished", node: "pc", window: "alpha", lane: "alpha", at: Date.UTC(2026, 9, 8, 9), status: "done", firstLine: "STATUS: DONE shipped" };
    const r = await lanes(["events", "--json"], {
      during: async () => { await until(() => fleet.subscriberCount() > 0, 10_000); fleet.laneEvent(e); },
      interruptWhen: out => out.includes("\n"),
    });
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n").map(l => JSON.parse(l) as unknown)).toEqual([e]);
  });

  it("bad arguments are 2: an unknown command, an option a command doesn't take, a missing lane", async () => {
    expect((await lanes(["fly"])).code).toBe(2);
    expect((await lanes(["peek", "alpha", "--kill"])).code).toBe(2);
    expect((await lanes(["send"])).code).toBe(2);
    expect((await lanes(["--frobnicate"])).code).toBe(2);
  });

  it("needs no hub: it reads no hub settings and opens no hub database (negative control)", async () => {
    const r = await lanes([], { env: { MORNDO_ORIGIN: "http://not-https.example" } });   // a setting serve would refuse
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(home, ".local/share/morndo"))).toBe(false);
  });
});
