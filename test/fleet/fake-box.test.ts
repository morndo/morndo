// The fake input box (test/fixtures/fake-claude-pane.ts) against the readers the node agent itself uses. A drill that
// passed on a box writing other shapes than Claude Code 2.1.293 would prove nothing, so each kind of line the box writes
// is read here by Task 2's receipt rules, its session file by the session registry, and its screens by the menu and input
// box checks and kira's menu parser (fleet clients spec §12; Global Constraints, "Claude Code internals"). An isolated
// tmux server; no fleet, no agent.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { menuQuestion } from "../../packages/node-ops/src/menu.ts";
import { readReceipts } from "../../packages/node-ops/src/receipt.ts";
import { sessionRegistry } from "../../packages/node-ops/src/sessions.ts";
import { inputBoxOnScreen, menuOnScreen } from "../../packages/node-ops/src/tmux.ts";
import { fakeLane, stopAll, tempDir, tmuxServer, until, type Lane, type TmuxServer } from "../fleet-harness.ts";

afterEach(stopAll);

async function box(): Promise<{ t: TmuxServer; lane: Lane; claude: string }> {
  const t = tmuxServer();
  const home = tempDir("morndo-box-");
  const lane = await fakeLane(t, { window: "box", claudeHome: home });
  return { t, lane, claude: join(home, ".claude") };
}
// Typed at the keyboard (not pasted), then Enter, as the owner would.
async function type(b: { t: TmuxServer; lane: Lane }, text: string) {
  b.t.run("send-keys", "-t", b.lane.paneId, "-l", text);
  b.t.run("send-keys", "-t", b.lane.paneId, "Enter");
  await until(`"${text}" submitted`, () => b.lane.submitted().includes(text));
}
const lines = (lane: Lane) => readFileSync(lane.transcript ?? "", "utf8").split("\n").filter(Boolean);
// Each pending text's last verdict, as the deliverer would end up reading it ("none" when no entry decided it).
function verdict(lane: Lane, text: string, typedAt: number): string {
  const all = readReceipts(lines(lane), [{ id: "d", text, typedAt }]);
  return all.filter(r => r.id === "d").at(-1)?.verdict ?? "none";
}
const statusOf = (b: { lane: Lane; claude: string }) => sessionRegistry(b.claude).byPane().get(b.lane.paneId)?.status ?? null;

describe("the fake input box writes what Claude Code 2.1.293 writes", () => {
  it("a prompt typed while idle is a receipt; the session file says idle", async () => {
    const b = await box();
    expect(statusOf(b)).toBe("idle");
    const at = Date.now();
    await type(b, "typed while idle");
    expect(verdict(b.lane, "typed while idle", at)).toBe("delivered");
  });

  it("typed while busy: held on its enqueue; a dequeue alone decides nothing; the queued prompt delivers it", async () => {
    const b = await box();
    await b.lane.control({ status: "busy" });
    expect(statusOf(b)).toBe("busy");
    const at = Date.now();
    await type(b, "queued while busy");
    expect(verdict(b.lane, "queued while busy", at)).toBe("held");
    await b.lane.control({ dequeue: true });
    expect(verdict(b.lane, "queued while busy", at)).toBe("held");
    await b.lane.control({ prompt: true, status: "idle" });
    expect(verdict(b.lane, "queued while busy", at)).toBe("delivered");
  });

  it("taken into the running turn (remove absorbed_mid_turn, then queued_command): delivered", async () => {
    const b = await box();
    await b.lane.control({ status: "busy" });
    const at = Date.now();
    await type(b, "absorbed mid turn");
    await b.lane.control({ absorb: true });
    expect(lines(b.lane).filter(l => l.includes("absorbed mid turn"))).toHaveLength(3);   // enqueue, remove, queued_command
    expect(verdict(b.lane, "absorbed mid turn", at)).toBe("delivered");
  });

  it("remove delivered_to_agent: delivered; a remove with a reason no rule names: still held", async () => {
    const b = await box();
    await b.lane.control({ status: "busy" });
    const at = Date.now();
    await type(b, "to the agent");
    await b.lane.control({ remove: "delivered_to_agent" });
    expect(verdict(b.lane, "to the agent", at)).toBe("delivered");
    await type(b, "moved somewhere new");
    await b.lane.control({ remove: "moved_elsewhere" });
    expect(verdict(b.lane, "moved somewhere new", at)).toBe("held");
  });

  it("an interrupt drops the queued line (cleared_on_cancel), and the session turns idle", async () => {
    const b = await box();
    await b.lane.control({ status: "busy" });
    const at = Date.now();
    await type(b, "dropped by the interrupt");
    await b.lane.control({ interrupt: {} });
    expect(verdict(b.lane, "dropped by the interrupt", at)).toBe("dropped");
    expect(statusOf(b)).toBe("idle");
  });

  it("a menu: no input box, a menu with its question, the session waiting; answered, the box is back", async () => {
    const b = await box();
    await b.lane.control({ status: "waiting", question: "Merge the docs branch?" });
    expect(statusOf(b)).toBe("waiting");
    const screen = b.lane.screen();
    expect(menuOnScreen(screen)).toBe(true);
    expect(inputBoxOnScreen(screen)).toBe(false);
    expect(menuQuestion(screen)).toBe("Merge the docs branch?");
    await b.lane.control({ status: "idle" });
    expect(inputBoxOnScreen(b.lane.screen())).toBe(true);
  });

  it("a shell command running (status shell, ruling 11): the box stays, a typed line is a prompt", async () => {
    const b = await box();
    await b.lane.control({ status: "shell" });
    expect(statusOf(b)).toBe("shell");
    expect(inputBoxOnScreen(b.lane.screen())).toBe(true);
    expect(menuOnScreen(b.lane.screen())).toBe(false);
    const at = Date.now();
    await type(b, "typed beside a shell command");
    expect(verdict(b.lane, "typed beside a shell command", at)).toBe("delivered");
  });

  it("/clear starts a new session (ruling 17): a new id in the same session file, and a new transcript", async () => {
    const b = await box();
    const before = sessionRegistry(b.claude).byPane().get(b.lane.paneId)?.sessionId;
    expect(before).toBe(b.lane.sessionId);
    await type(b, "/clear");
    const after = await until("a new session id", () => {
      const s = sessionRegistry(b.claude).byPane().get(b.lane.paneId)?.sessionId;
      return s && s !== before ? s : null;
    });
    expect(existsSync(join(b.claude, "projects", "-qa", `${after}.jsonl`))).toBe(true);
  });

  it("/exit ends the process: the session is no longer live", async () => {
    const b = await box();
    await type(b, "/exit");
    await until("the session gone from the registry", () => !sessionRegistry(b.claude).byPane().has(b.lane.paneId));
  });

  it("starting: no box and no session file until the delay has passed", async () => {
    const t = tmuxServer();
    const home = tempDir("morndo-box-");
    const lane = await fakeLane(t, { window: "late", claudeHome: home, startDelayMs: 2500, wait: false });
    await until("the starting screen", () => lane.screen().includes("Starting Claude Code"));
    expect(inputBoxOnScreen(lane.screen())).toBe(false);
    expect(sessionRegistry(join(home, ".claude")).byPane().get(lane.paneId)).toBeUndefined();
    await until("the box after the delay", () => inputBoxOnScreen(lane.screen()), 8000);
    expect(sessionRegistry(join(home, ".claude")).byPane().get(lane.paneId)?.status).toBe("idle");
  });
});
