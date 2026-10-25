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
import { DEFAULT_POLICY } from "@morndo/domain";
import { LIMITS, type LaneEvent } from "@morndo/protocol";
import { Store } from "../src/adapters/store.ts";
import { BoardService } from "../src/application/board-service.ts";
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

// A Claude Code session file: one JSON object a line (made-up messages; the key is made up too, built in two parts).
const FAKE_KEY = `sk-ant-${"api03-"}${"A".repeat(40)}`;
const jsonl = (rows: object[]) => new TextEncoder().encode(`${rows.map(r => JSON.stringify(r)).join("\n")}\n`);
const said = (type: "user" | "assistant", content: unknown, at = "2026-10-26T10:00:00Z") => ({ type, uuid: `u-${Math.random()}`, timestamp: at, message: { role: type, content } });
const SESSION = jsonl([
  said("user", "first question"),
  said("assistant", [{ type: "text", text: "answer one\nwith a second line" }]),
  said("assistant", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "echo TOOLINPUT-SHOULD-NOT-SHOW" } }]),
  said("user", [{ type: "tool_result", tool_use_id: "t1", content: "TOOLOUTPUT-SHOULD-NOT-SHOW" }]),
  said("assistant", [{ type: "thinking", thinking: "THINKING-SHOULD-NOT-SHOW" }, { type: "text", text: `key was ${FAKE_KEY} in the notes` }]),
  said("user", "last question"),
  said("assistant", [{ type: "text", text: "last answer" }]),
]);
const LABEL = /^-- transcript text .*alternate screen/;

describe("morndo lanes peek --lines past the screen, on the alternate screen (T-336)", () => {
  // Claude Code's fullscreen renderer draws on tmux's alternate screen, where tmux keeps no scrollback: the screen is all
  // capture-pane can give, so peek reads the end of the lane's session transcript instead, as plain text.
  let b: MemoryBackend;
  const start = async (o: { refuse?: boolean; transcripts?: Record<string, Uint8Array> } = {}) => {
    await fleet.close();
    b = memoryBackend({
      "%0": { name: "alt", cwd: "/w/alt", screen: "s1\ns2\n❯ ", sessionId: "s-alt", altScreen: true },
      "%1": { name: "plain", cwd: "/w/plain", screen: "p1\n❯ ", sessionId: "s-plain" },
      "%2": { name: "altshell", cwd: "/w", screen: "$ ", altScreen: true },
    }, { transcripts: o.transcripts ?? { "s-alt": SESSION, "s-plain": SESSION } });
    if (o.refuse) b.refuseTranscripts = true;
    fleet = await startFakeFleet({ nodes: [localNode("pc", "aaaaaaaa", b)] });
  };

  it("prints the end of the session's messages, labelled, as N lines of plain text (no tool calls, results or thinking)", async () => {
    await start();
    const r = await lanes(["peek", "alt", "--lines", "100"]);
    expect(r.code, r.err).toBe(0);
    const [label, ...body] = r.out.trimEnd().split("\n");
    expect(label).toMatch(LABEL);
    expect(body).toEqual([
      "user: first question", "assistant: answer one", "with a second line",
      expect.stringContaining("key was "), "user: last question", "assistant: last answer",
    ]);
    expect(r.out).not.toMatch(/SHOULD-NOT-SHOW/);
    expect(r.err).toBe("");
  });

  it("reads the transcript through the fleet's transcript.size and transcript.read ops, on the lane's node, as the lanes client", async () => {
    // Through the client socket it was started with, so that socket's scope decides (a worker socket is refused both, below).
    await start();
    const before = fleet.calls.length;
    const r = await lanes(["peek", "alt", "--lines", "100"]);
    expect(r.code, r.err).toBe(0);
    const ops = fleet.calls.slice(before).filter(c => c.op.startsWith("transcript."));
    expect(ops.map(c => c.op)).toEqual(["transcript.size", "transcript.read"]);
    expect(ops.every(c => c.node === "pc" && c.args && (c.args as { sessionId?: string }).sessionId === "s-alt")).toBe(true);
    expect(new Set(fleet.clients)).toEqual(new Set(["lanes"]));
  });

  it("keeps only the last N lines of that text, and redacts key material in it", async () => {
    await start();
    const r = await lanes(["peek", "alt", "--lines", "5"]);
    expect(r.code, r.err).toBe(0);
    const [label, ...body] = r.out.trimEnd().split("\n");
    expect(label).toMatch(LABEL);
    expect(body).toHaveLength(5);
    expect(body.at(-1)).toBe("assistant: last answer");
    expect(r.out).not.toContain(FAKE_KEY);
    expect(r.out).not.toContain("A".repeat(20));
  });

  it("reads the end of a transcript longer than one chunk, from its end", async () => {
    const rows = Array.from({ length: 4000 }, (_, i) => said(i % 2 ? "assistant" : "user", i % 2 ? [{ type: "text", text: `reply ${i} ${"x".repeat(100)}` }] : `ask ${i}`));
    const big = jsonl(rows);
    expect(big.length).toBeGreaterThan(LIMITS.chunkBytes);
    await start({ transcripts: { "s-alt": big } });
    const r = await lanes(["peek", "alt", "--lines", "4"]);          // more than the screen's 3 rows
    expect(r.code, r.err).toBe(0);
    const [label, ...body] = r.out.trimEnd().split("\n");
    expect(label).toMatch(LABEL);
    expect(body).toEqual(["user: ask 3996", expect.stringContaining("reply 3997"), "user: ask 3998", expect.stringContaining("reply 3999")]);
  });

  it("--json: the text, and where it came from", async () => {
    await start();
    const r = await lanes(["peek", "alt", "--lines", "100", "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ source: "transcript", truncated: false, text: expect.stringContaining("assistant: last answer") });
  });

  it("prints the screen as before when the lines asked for fit on it, or the pane is not on the alternate screen", async () => {
    await start();
    expect((await lanes(["peek", "alt", "--lines", "3"])).out).toBe("s1\ns2\n❯ \n");
    const plain = await lanes(["peek", "plain", "--lines", "100"]);
    expect(plain.out).toBe("p1\n❯ \n");
    expect(plain.err).toBe("");
  });

  it("from a worker socket (transcript ops refused): the screen, and one line saying why there is no more", async () => {
    await start({ refuse: true });
    const r = await lanes(["peek", "alt", "--lines", "100"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe("s1\ns2\n❯ \n");
    expect(r.err.trimEnd().split("\n")).toHaveLength(1);
    expect(r.err).toMatch(/note: .*scrollback.*transcript.*worker socket/i);
  });

  it("a lane with no session: the screen, and a note that there is no transcript", async () => {
    await start();
    const r = await lanes(["peek", "altshell", "--lines", "100"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe("$ \n");
    expect(r.err.trimEnd().split("\n")).toHaveLength(1);
    expect(r.err).toMatch(/note: .*no session transcript/i);
  });

  it("a session whose transcript is gone: the screen, and a note", async () => {
    await start({ transcripts: {} });
    const r = await lanes(["peek", "alt", "--lines", "100"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe("s1\ns2\n❯ \n");
    expect(r.err).toMatch(/note: .*transcript/i);
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

  it("start: a prompt of up to maxMessageText goes to the node whole; a longer one is refused in one line, nothing assigned or sent", async () => {
    fleet.intercept("lane.start", async () => ({ ok: true, result: { workerId: "pc.aaaaaaaa.9", prompt: "lanes:start:x:prompt" } }));
    // ASCII at the bound: one argv element holds at most 131,072 bytes (MAX_ARG_STRLEN), so a multi-byte prompt of this
    // length cannot be an argument at all; the fleet's own tests carry the multi-byte one.
    const whole = "x".repeat(LIMITS.maxMessageText);
    expect(whole).toHaveLength(LIMITS.maxMessageText);
    const r = await lanes(["start", "build", "--cwd", "/w/build", "--prompt", whole]);
    expect(r.code, r.err).toBe(0);
    expect(fleet.calls.filter(c => c.op === "lane.start").at(-1)?.args).toMatchObject({ name: "build", cwd: "/w/build", prompt: whole });
    // The hub's own board too: a refused prompt assigns no task (the guard runs before assignTask).
    const hubHome = join(home, "hub");
    const manager = { kind: "manager", name: "manager", token: "tok-m" } as const;
    const seeded = new Store(hubHome);
    new BoardService({ store: seeded, policy: () => DEFAULT_POLICY }).create({ title: "Build the login page" }, manager);   // T-1, nobody's
    seeded.close();
    const starts = fleet.calls.filter(c => c.op === "lane.start").length;
    const over = await lanes(["start", "build", "--cwd", "/w/build", "--task", "T-1", "--prompt", "x".repeat(LIMITS.maxMessageText + 1)], { env: { MORNDO_HOME: hubHome } });
    expect([over.code, over.err]).toEqual([2, expect.stringContaining(`the prompt is over ${LIMITS.maxMessageText} characters`)]);
    expect(fleet.calls.filter(c => c.op === "lane.start")).toHaveLength(starts);       // nothing was sent
    const s = new Store(hubHome);
    try {
      expect(new BoardService({ store: s, policy: () => DEFAULT_POLICY }).task("T-1")?.task).toMatchObject({ assignee: null, status: "backlog" });
    } finally { s.close(); }
  });

  it("start --task: the task is the new lane's first, assigned as the console on the hub's board; an unknown or done task starts nothing", async () => {
    // The hub's database (MORNDO_HOME), as the hub left it: a task for nobody, one that is done.
    const hubHome = join(home, "hub");
    const manager = { kind: "manager", name: "manager", token: "tok-m" } as const;
    const seeded = new Store(hubHome);
    const board = new BoardService({ store: seeded, policy: () => DEFAULT_POLICY });
    board.create({ title: "Build the login page" }, manager);                        // T-1, backlog, nobody's
    board.create({ title: "Old work", assignee: "builder" }, manager);               // T-2, done below
    for (const [to, reason] of [["doing", undefined], ["review", undefined], ["done", "npm test: 14 passed"]] as const) {
      board.act("T-2", { action: "move", to, ...(reason ? { reason } : {}) }, manager);
    }
    seeded.close();
    const env = { MORNDO_HOME: hubHome };
    const readBack = <T>(f: (b: BoardService, s: Store) => T): T => {
      const s = new Store(hubHome);
      try { return f(new BoardService({ store: s, policy: () => DEFAULT_POLICY }), s); } finally { s.close(); }
    };
    // Assigned before lane.start is asked (so the lane's first turn is after the task's last change: D4, not D6).
    let assigneeAtStart: string | null | undefined;
    fleet.intercept("lane.start", async () => {
      assigneeAtStart = readBack(b => b.task("T-1")?.task.assignee);
      return { ok: true, result: { workerId: "pc.aaaaaaaa.9" } };
    });
    const r = await lanes(["start", "build", "--cwd", "/w/build", "--task", "T-1"], { env });
    expect(r.code, r.err).toBe(0);
    expect(assigneeAtStart).toBe("build");
    expect(r.out).toContain("started build on pc: pc.aaaaaaaa.9\nT-1 is assigned to it: its first turn moves it into progress");
    expect(fleet.calls.filter(c => c.op === "lane.start").at(-1)?.args).toEqual({ name: "build", cwd: "/w/build" });   // --task is the hub's, not the node's
    const after = readBack((b, s) => ({ task: b.task("T-1"), audit: s.auditOf("BoardChanged", 0) }));
    expect(after.task?.task).toMatchObject({ assignee: "build", status: "todo" });
    expect(after.task?.events.at(-1)).toMatchObject({ actor: { kind: "console" }, change: { kind: "assigned", from: null, to: "build" } });
    expect(after.audit.at(-1)).toMatchObject({ key: "T-1", change: "assigned", actor: { kind: "console", name: null, endpointId: null, token: null } });
    // Again for the lane it already names: nothing to change, and the start goes ahead. --json names the task.
    const again = await lanes(["start", "build", "--cwd", "/w/build", "--task", "T-1", "--json"], { env });
    expect(again.code, again.err).toBe(0);
    expect(JSON.parse(again.out)).toEqual({ node: "pc", workerId: "pc.aaaaaaaa.9", task: "T-1" });
    expect(readBack(b => b.task("T-1")?.events.length)).toBe(after.task?.events.length);

    const starts = fleet.calls.filter(c => c.op === "lane.start").length;
    const unknown = await lanes(["start", "build", "--cwd", "/w/build", "--task", "T-9"], { env });
    expect([unknown.code, unknown.err.trim()]).toEqual([4, "refused: no task T-9"]);
    const done = await lanes(["start", "build", "--cwd", "/w/build", "--task", "T-2"], { env });
    // negative control: without the done check, T-2 goes to "build" and the lane starts (lanes-task-done).
    expect([done.code, done.err.trim()]).toEqual([4, "refused: T-2 is done; file a new task for more work"]);
    expect(readBack(b => b.task("T-2")?.task)).toMatchObject({ status: "done", assignee: "builder" });
    const noHub = await lanes(["start", "build", "--cwd", "/w/build", "--task", "T-1"], { env: { MORNDO_HOME: join(home, "nowhere") } });
    expect([noHub.code, noHub.err]).toEqual([4, expect.stringContaining("refused: no task T-1: there is no hub database in")]);
    expect(existsSync(join(home, "nowhere"))).toBe(false);                               // never made here
    expect(fleet.calls.filter(c => c.op === "lane.start")).toHaveLength(starts);       // none of them started anything
    expect((await lanes(["start", "build", "--cwd", "/w/build", "--task", "12"], { env })).code).toBe(2);

    // A start that fails after the assignment says where the task stays.
    fleet.intercept("lane.start", async () => refusal("name_taken", "a window named build is there"));
    const taken = await lanes(["start", "build", "--cwd", "/w/build", "--task", "T-1"], { env });
    expect(taken.code).toBe(4);
    expect(taken.err).toContain("T-1 stays assigned to build: morndo-board assign T-1 <lane> hands it on");
    expect((await lanes(["--help"])).out).toContain("[--prompt TEXT] [--task T-12] [--json]");
  });

  it("start on an engine: --role or --engine with --reason reach lane.start; the answer says what ran and what it passed over", async () => {
    const skipped = [{ entry: "acme:large-2@high", reason: "acme: not signed in" }];
    fleet.intercept("lane.start", async () => ({ ok: true, result: { workerId: "pc.aaaaaaaa.9", engine: { entry: "beta:mid-3", role: "implement", skipped } } }));
    const r = await lanes(["start", "build", "--cwd", "/w/build", "--role", "implement"]);
    expect(r.code, r.err).toBe(0);
    expect(fleet.calls.filter(c => c.op === "lane.start").at(-1)?.args).toEqual({ name: "build", cwd: "/w/build", role: "implement" });
    expect(r.out).toContain("it runs beta:mid-3 (role implement)");
    expect(r.out).toContain("passed over first: acme:large-2@high (acme: not signed in)");
    expect((await lanes(["start", "build", "--cwd", "/w/build", "--engine", "acme:large-2", "--reason", "owner's call"])).code).toBe(0);
    expect(fleet.calls.filter(c => c.op === "lane.start").at(-1)?.args).toEqual({ name: "build", cwd: "/w/build", engine: "acme:large-2", reason: "owner's call" });
    const both = await lanes(["start", "build", "--cwd", "/w/build", "--role", "implement", "--engine", "acme:large-2"]);
    expect([both.code, both.err]).toEqual([2, expect.stringContaining("--role or --engine, not both")]);
  });

  it("brief: the lanes' last turns (stale first), deliveries not yet taken and the day's alerts, from the fleet", async () => {
    const now = Date.now();
    fleet.setLaneWatch([
      { node: "pc", window: "alpha", at: now - 40 * 60_000, status: null, deadline: now - 25 * 60_000, reason: "no_status", stale: true, stalls: 2 },
    ]);
    fleet.raise({ id: 1, at: now - 60_000, node: "pc", kind: "engine_fallback", detail: { lane: "alpha", entry: "beta:mid-3" } });
    const r = await lanes(["brief"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/^Fleet brief, /);
    expect(r.out).toContain("alpha@pc · no status · 40 min ago · STALE x2");
    expect(r.out).toContain("no turn seen in the last day: manager@pc");
    expect(r.out).toContain("engine_fallback on pc alpha");
    const json = JSON.parse((await lanes(["brief", "--json"])).out) as { watch: unknown[]; alerts: unknown[] };
    expect([json.watch.length, json.alerts.length]).toEqual([1, 1]);
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

  it("stop --keep-window asks the node to leave the window; without it the arg is not sent; --kill takes no --keep-window", async () => {
    fleet.intercept("lane.stop", async () => ({ ok: true, result: { ok: true } }));
    expect((await lanes(["stop", "alpha", "--keep-window"])).code).toBe(0);
    expect(fleet.calls.filter(c => c.op === "lane.stop").map(c => c.args)).toEqual([{ name: "alpha", mode: "exit", keepWindow: true }]);
    const both = await lanes(["stop", "alpha", "--kill", "--keep-window"]);
    expect(both.code).toBe(2);
    expect(both.err).toContain("--keep-window");
  });

  // QA on two machines (PR #34): a window named by hand on a second node puts a name in conflict, and the fleet's refusal
  // says to address one by its worker ID. Every command that takes a lane takes one, and routes to that node.
  it("a worker ID names one of two windows that share a name: peek, send, keys and stop reach it; the name alone is refused", async () => {
    await fleet.close();
    const mac = memoryBackend({ "%0": { name: "alpha", cwd: "/m/alpha", screen: "m1\nm2\n❯ ", sessionId: "s-m2", status: "idle", pid: 5151 } });
    fleet = await startFakeFleet({ nodes: [localNode("pc", "aaaaaaaa", backend), localNode("mac", "bbbbbbbb", mac)] });
    const byName = await lanes(["peek", "alpha"]);
    expect(byName.code).toBe(4);
    expect(byName.err).toContain("name one by its worker ID");
    expect((await lanes(["send", "alpha", "x"])).code).toBe(4);                       // lane_conflict, by the fleet
    expect((await lanes(["peek", "mac.bbbbbbbb.0", "--lines", "2"])).out).toBe("m2\n❯ \n");
    expect((await lanes(["send", "mac.bbbbbbbb.0", "to the mac's alpha"])).code).toBe(0);
    expect(fleet.deliveryCalls.at(-1)).toMatchObject({ lane: null, workerId: "mac.bbbbbbbb.0", text: "to the mac's alpha" });
    expect((await lanes(["keys", "mac.bbbbbbbb.0", "Escape"])).code).toBe(0);
    expect(mac.keyNamesTyped).toEqual([{ pane: "%0", names: ["Escape"] }]);
    expect(backend.keyNamesTyped).toEqual([]);                                       // negative control: not the pc's alpha
    fleet.intercept("lane.stop", async () => ({ ok: true, result: { ok: true } }));
    expect((await lanes(["stop", "mac.bbbbbbbb.0"])).code).toBe(0);
    expect(fleet.calls.filter(c => c.op === "lane.stop").at(-1)).toMatchObject({ target: { workerId: "mac.bbbbbbbb.0" }, args: { name: "alpha", mode: "exit" } });
    expect((await lanes(["peek", "mac.bbbbbbbb.9"])).err).toContain("no lane with worker ID mac.bbbbbbbb.9");
  });

  it("status takes the id as --id took it: a bare id is lanes:<id>", async () => {
    await lanes(["send", "manager", "x", "--id", "s2"]);
    expect(await lanes(["status", "s2"])).toMatchObject({ code: 0, out: "lanes:s2: queued\n" });
    expect(await lanes(["status", "lanes:s2"])).toMatchObject({ code: 0, out: "lanes:s2: queued\n" });
    expect((await lanes(["status", "nope"])).err).toContain("no delivery lanes:nope");
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
