// The launcher and lane.start/lane.stop of fleet clients (spec §5) on an isolated tmux server, with:
// - stand-ins on the server's PATH;
// - the real trust dialog's screen (Claude Code 2.1.287);
// - the agent's fake box (fake-claude.fixture.ts), which ends on /exit, and with --tasks asks "Exit and stop tasks" first;
// - a session the test writes (claude-session.ts).
// A window started from the shell gets bash without rc files (tmux's default-command), so no test reads the account's
// own shell setup.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Launch, Policy } from "../src/config.ts";
import { launchCommand, promptId, shellLine, trustDialogOnScreen, type LaneWaits } from "../src/ops/lane-ops.ts";
import { claudeSession } from "./claude-session.ts";
import { isolatedTmux, tempHome, until, type TestTmux } from "./helpers.ts";
import { opsHarness, type Harness } from "./ops-harness.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const FIXTURE = join(import.meta.dirname, "fake-claude.fixture.ts");
const SCREENS = join(ROOT, "packages", "node-ops", "test", "fixtures", "claude-code-2.1.287");
const TRUST_SCREEN = join(SCREENS, "trust-dialog.ansi");
// A lane that shows the recorded trust dialog and stays. The recording ends in 29 blank lines, which would scroll the
// dialog off a 24-line pane; `$(…)` drops them.
const TRUST_LANE = ["sh", "-c", `printf '%s\\n' "$(cat '${TRUST_SCREEN}')"; exec sleep 600`];
const RESUME = "3f0c1d2e-1111-4222-8333-444455556666";
const SHELL = "bash --norc --noprofile";

let home: { home: string; cleanup: () => void };
let t: TestTmux;
let bin = "";
let argvDir = "";
let work = "";
const harnesses: Harness[] = [];
const savedPath = process.env.PATH;
const savedArgv = process.env.MORNDO_TEST_ARGV;

beforeEach(() => {
  home = tempHome();
  bin = join(home.home, "bin");
  argvDir = join(home.home, "argv");
  work = join(home.home, "work");
  for (const dir of [bin, argvDir, work]) mkdirSync(dir, { recursive: true });
  // claude-as records its arguments and stays, like a lane; claude-quick records them and ends at once.
  writeFileSync(join(bin, "claude-as"), `#!/bin/sh\nprintf '%s\\n' "$(basename "$0")" "$@" > "$MORNDO_TEST_ARGV/$(basename "$0").argv"\nexec sleep 600\n`);
  writeFileSync(join(bin, "claude-quick"), `#!/bin/sh\nprintf '%s\\n' "$(basename "$0")" "$@" > "$MORNDO_TEST_ARGV/$(basename "$0").argv"\n`);
  for (const f of ["claude-as", "claude-quick"]) chmodSync(join(bin, f), 0o755);
  // The tmux server takes its environment, the stand-ins' PATH included, when it is made: so after this.
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  process.env.MORNDO_TEST_ARGV = argvDir;
  t = isolatedTmux();
  t.tmux("new-session", "-d", "-s", "main", "-n", "base", "sleep 600");
  t.tmux("set-option", "-g", "default-command", SHELL);         // a window started without a command gets this
});
afterEach(async () => {
  for (const h of harnesses.splice(0)) { h.deliverer.stop(); await h.deliverer.drain(); h.close(); }
  await t.kill();
  process.env.PATH = savedPath;
  if (savedArgv === undefined) delete process.env.MORNDO_TEST_ARGV; else process.env.MORNDO_TEST_ARGV = savedArgv;
  home.cleanup();
});

function harness(launch: Launch, waits: Partial<LaneWaits> = {}, policy: Partial<Policy> = {}): Harness {
  const h = opsHarness({ home: home.home, socket: t.socket, policy: { launch, ...policy }, laneWaits: { pollMs: 100, trustMs: 500, stopMs: 3000, ...waits } });
  harnesses.push(h);
  return h;
}
const argv = (name: string) => (existsSync(join(argvDir, `${name}.argv`)) ? readFileSync(join(argvDir, `${name}.argv`), "utf8").trim().split("\n") : null);
const paneOf = (workerId: string) => `%${workerId.replace(/^.*\./, "")}`;
const show = (...args: string[]) => t.tmux(...args).replace(/\n$/, "");
const windows = () => show("list-windows", "-t", "=main", "-F", "#{window_name}").split("\n");
const submitted = (dir: string) => (existsSync(join(dir, "submitted.jsonl"))
  ? readFileSync(join(dir, "submitted.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as string) : []);
const boxIn = (name: string) => { const dir = join(home.home, name); mkdirSync(dir, { recursive: true }); return dir; };
const showsBox = (workerId: string) => until(() => t.tmux("capture-pane", "-p", "-t", paneOf(workerId)).includes("❯"));
async function start(h: Harness, args: Record<string, unknown>, key: string) {
  const r = await h.call("lane.start", { cwd: work, ...args }, { key, timeoutMs: 30_000 });
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.result as { workerId: string; waiting?: "trust"; prompt?: string };
}

describe("the launcher's command (spec §5, §11)", () => {
  it("fills {account} wherever it stands, adds --resume, and refuses an account where it has no place or none where it needs one", () => {
    expect(launchCommand({ command: ["claude"], via: "shell" }, {})).toEqual(["claude"]);
    expect(launchCommand({ command: ["claude"], via: "shell" }, { resume: RESUME })).toEqual(["claude", "--resume", RESUME]);
    expect(launchCommand({ command: ["claude-as", "{account}"], via: "shell" }, { account: "acct", resume: RESUME })).toEqual(["claude-as", "acct", "--resume", RESUME]);
    expect(launchCommand({ command: ["run", "--profile={account}", "claude"], via: "direct" }, { account: "a2" })).toEqual(["run", "--profile=a2", "claude"]);
    expect(launchCommand({ command: ["claude"], via: "shell" }, { account: "acct" })).toEqual({ refused: expect.stringContaining("takes no account") });
    expect(launchCommand({ command: ["claude-as", "{account}"], via: "shell" }, {})).toEqual({ refused: expect.stringContaining("needs an account") });
    // A first prompt's id (ruling 7): the key's client, "prompt", 16 hex of the key's SHA-256; short whatever the key.
    expect(promptId("lanes:p1")).toBe(`lanes:prompt:${createHash("sha256").update("lanes:p1").digest("hex").slice(0, 16)}`);
    expect(promptId(`kira:${"k".repeat(500)}`)).toMatch(/^kira:prompt:[0-9a-f]{16}$/);
  });

  it("quotes a word for the shell unless it is plainly safe", () => {
    expect(shellLine(["claude-as", "acct", "--resume", RESUME])).toBe(`claude-as acct --resume ${RESUME}`);
    expect(shellLine(["sh", "-c", "echo it's $HOME; rm x"])).toBe("sh -c 'echo it'\\''s $HOME; rm x'");
    expect(shellLine(["/opt/my tools/claude"])).toBe("'/opt/my tools/claude'");
  });

  it("knows the real trust dialog (Claude Code 2.1.287), and no other screen as one", () => {
    expect(trustDialogOnScreen(readFileSync(TRUST_SCREEN, "utf8"))).toBe(true);
    for (const other of ["typed-draft", "permission-prompt", "exited-to-shell"]) {
      expect(trustDialogOnScreen(readFileSync(join(SCREENS, `${other}.ansi`), "utf8")), other).toBe(false);
    }
  });
});

describe("lane.start (spec §5)", () => {
  it("via direct: the command's words are the pane's own program, with {account} filled", async () => {
    const h = harness({ command: ["claude-as", "{account}"], via: "direct" });
    await start(h, { name: "direct", account: "acct", resume: RESUME }, "lanes:d1");
    expect(await until(() => argv("claude-as") !== null)).toBe(true);
    expect(argv("claude-as")).toEqual(["claude-as", "acct", "--resume", RESUME]);
  });

  it("via shell: the window starts with the shell, the launcher is pasted at its prompt, and the shell stays under the lane once it ends", async () => {
    const h = harness({ command: ["claude-quick", "{account}"], via: "shell" });
    const r = await start(h, { name: "shelled", account: "acct" }, "lanes:s1");
    expect(await until(() => argv("claude-quick") !== null)).toBe(true);
    expect(argv("claude-quick")).toEqual(["claude-quick", "acct"]);
    const pane = paneOf(r.workerId);
    expect(await until(() => show("display-message", "-p", "-t", pane, "#{pane_current_command}") === "bash")).toBe(true);
    expect(windows()).toContain("shelled");
    expect(t.tmux("capture-pane", "-p", "-t", pane)).toContain("claude-quick acct");
  });

  it("refuses an account the launcher has no place for, and none where it needs one: bad_args, not executed, nothing started", async () => {
    const plain = harness({ command: ["claude"], via: "direct" });
    expect(await plain.call("lane.start", { name: "x", cwd: work, account: "acct" }, { key: "lanes:a1" })).toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });
    expect(plain.doneKeys.status("lanes:a1")).toEqual({ state: "unknown" });
    const templated = harness({ command: ["claude-as", "{account}"], via: "direct" });
    expect(await templated.call("lane.start", { name: "x", cwd: work }, { key: "lanes:a2" })).toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });
    expect(windows()).toEqual(["base"]);
  });

  it("answers waiting: trust when Claude Code's folder-trust dialog shows, and nothing when its box does", async () => {
    const untrusted = harness({ command: TRUST_LANE, via: "direct" }, { trustMs: 5000 });
    expect(await start(untrusted, { name: "untrusted" }, "lanes:t1")).toMatchObject({ waiting: "trust" });
    const trusted = harness({ command: [process.execPath, FIXTURE, boxIn("trusted")], via: "direct" }, { trustMs: 5000 });
    expect(await start(trusted, { name: "trusted" }, "lanes:t2")).not.toHaveProperty("waiting");
  });

  it("does not read the whole inventory on every look for the trust dialog under a shell prompt that is drawn as ❯ (negative control)", async () => {
    const h = harness({ command: ["sh", "-c", "printf '❯ '; exec sleep 600"], via: "direct" }, { trustMs: 1200 });
    const refresh = vi.spyOn(h.inventory, "refresh");
    expect(await start(h, { name: "prompt-shell" }, "lanes:q1")).not.toHaveProperty("waiting");
    expect(refresh.mock.calls.length).toBeLessThanOrEqual(4);          // the start's own reads, not one per 100 ms look
  });

  it("does not wait out the trust dialog's time for an engine lane: its input line and its registered lane end the look", async () => {
    vi.stubEnv("ENGINES_SESSIONS", "");
    vi.stubEnv("ENGINES_TRANSCRIPTS", "");
    try {
      const dir = boxIn("engine");
      const h = harness({ command: [process.execPath, join(import.meta.dirname, "fake-engine-lane.fixture.ts"), home.home, dir], via: "direct" }, { trustMs: 8000 });
      const began = performance.now();
      expect(await start(h, { name: "eng" }, "lanes:q2")).not.toHaveProperty("waiting");
      expect(performance.now() - began).toBeLessThan(5000);
    } finally { vi.unstubAllEnvs(); }
  });

  it("queues a first prompt as a delivery to the new pane: it waits for Claude Code, and is typed once the lane can take it", async () => {
    const dir = boxIn("prompted");
    const h = harness({ command: [process.execPath, FIXTURE, dir], via: "direct" });
    const r = await start(h, { name: "prompted", prompt: "Build the login page" }, "lanes:p1");
    const id = promptId("lanes:p1");
    expect(r.prompt).toBe(id);
    expect(h.deliveries.get(id)).toMatchObject({ target: { workerId: r.workerId }, state: "queued" });
    expect(await showsBox(r.workerId)).toBe(true);
    const kick = async () => { await h.inventory.refresh(); h.deliverer.kick("status"); await h.deliverer.drain(); };
    // No Claude Code session in the pane yet: the prompt waits (no_session), within its pane process's grace (ruling 14).
    expect(await until(async () => { await kick(); return h.deliveries.get(id)?.waiting?.reason === "no_session"; })).toBe(true);
    expect(submitted(dir)).toEqual([]);
    claudeSession({ tmux: t, claudeDir: join(home.home, ".claude"), pane: paneOf(r.workerId) }).status("idle");
    expect(await until(async () => { await kick(); return submitted(dir).length > 0; })).toBe(true);
    expect(submitted(dir)).toEqual(["Build the login page"]);
    expect(h.deliveries.get(id)?.state).toBe("typed");
  });

  it("a 20,000-character first prompt reaches a long-text node intact", async () => {
    const dir = boxIn("long-prompted");
    const h = harness({ command: [process.execPath, FIXTURE, dir], via: "direct" });
    const prompt = 'ü€"\n'.repeat(4999) + 'ü€"x';                                     // exactly 20,000 characters, one bracketed paste
    expect(prompt).toHaveLength(20_000);
    const r = await start(h, { name: "long-prompted", prompt }, "lanes:p2");
    const id = promptId("lanes:p2");
    expect(r.prompt).toBe(id);
    expect(await showsBox(r.workerId)).toBe(true);
    const kick = async () => { await h.inventory.refresh(); h.deliverer.kick("status"); await h.deliverer.drain(); };
    expect(await until(async () => { await kick(); return h.deliveries.get(id)?.waiting?.reason === "no_session"; })).toBe(true);
    claudeSession({ tmux: t, claudeDir: join(home.home, ".claude"), pane: paneOf(r.workerId) }).status("idle");
    expect(await until(async () => { await kick(); return submitted(dir).length > 0; })).toBe(true);
    expect(submitted(dir)).toEqual([prompt]);
    expect(h.deliveries.get(id)?.state).toBe("typed");
  });
});

describe("lane.stop (spec §5)", () => {
  it("refuses a protected name in either mode (denied, not executed, the key freed)", async () => {
    const h = harness({ command: ["claude"], via: "direct" });
    t.tmux("new-window", "-d", "-t", "=main:", "-n", "manager", SHELL);
    expect(await h.call("lane.stop", { name: "manager" }, { key: "lanes:x1" })).toMatchObject({ ok: false, error: { code: "denied", executed: "no" } });
    expect(await h.call("lane.stop", { name: "manager", mode: "kill" }, { key: "lanes:x2" })).toMatchObject({ ok: false, error: { code: "denied", executed: "no" } });
    expect(h.doneKeys.status("lanes:x1")).toEqual({ state: "unknown" });
    expect(windows()).toContain("manager");
  });

  it("mode exit types /exit, answers Claude Code's 'Exit and stop tasks' with 1, and answers once the window has closed", async () => {
    const dir = boxIn("tasks");
    const h = harness({ command: [process.execPath, FIXTURE, dir, "--tasks"], via: "direct" });
    const r = await start(h, { name: "with-tasks" }, "lanes:e1");
    expect(await showsBox(r.workerId)).toBe(true);
    expect(await h.call("lane.stop", { name: "with-tasks" }, { key: "lanes:e2", timeoutMs: 30_000 })).toMatchObject({ ok: true, result: { ok: true } });
    expect(windows()).not.toContain("with-tasks");
    expect(submitted(dir)).toEqual(["/exit"]);
  });

  it("mode exit on a lane started from the shell answers once the pane is back at its shell, and the window stays", async () => {
    const dir = boxIn("plain");
    const h = harness({ command: [process.execPath, FIXTURE, dir], via: "shell" }, { shellMs: 5000 });
    const r = await start(h, { name: "shell-lane" }, "lanes:e3");
    expect(await showsBox(r.workerId)).toBe(true);
    expect(await h.call("lane.stop", { name: "shell-lane" }, { key: "lanes:e4", timeoutMs: 30_000 })).toMatchObject({ ok: true, result: { ok: true } });
    expect(windows()).toContain("shell-lane");
    expect(show("display-message", "-p", "-t", paneOf(r.workerId), "#{pane_current_command}")).toBe("bash");
    expect(submitted(dir)).toEqual(["/exit"]);
  });

  it("mode exit never types into a menu (menu_open, not executed), and is uncertain when the lane neither closes nor reaches its shell in time", async () => {
    const inMenu = harness({ command: TRUST_LANE, via: "direct" });
    const m = await start(inMenu, { name: "in-menu" }, "lanes:m1");
    expect(await until(() => t.tmux("capture-pane", "-p", "-t", paneOf(m.workerId)).includes("trust this folder"))).toBe(true);
    expect(await inMenu.call("lane.stop", { name: "in-menu" }, { key: "lanes:m2" })).toMatchObject({ ok: false, error: { code: "menu_open", executed: "no" } });
    expect(inMenu.doneKeys.status("lanes:m2")).toEqual({ state: "unknown" });
    const dir = boxIn("stays");
    const stays = harness({ command: [process.execPath, FIXTURE, dir, "--stay"], via: "direct" });
    const r = await start(stays, { name: "stays" }, "lanes:m3");
    expect(await showsBox(r.workerId)).toBe(true);
    expect(await stays.call("lane.stop", { name: "stays" }, { key: "lanes:m4", timeoutMs: 30_000 })).toMatchObject({ ok: false, error: { code: "uncertain", executed: "maybe" } });
    expect(stays.doneKeys.status("lanes:m4")).toEqual({ state: "started" });
    expect(submitted(dir)).toEqual(["/exit"]);
    expect(windows()).toContain("stays");
  });

  it("mode exit counts a lane with a live Claude Code session as running, whatever its status says (ruling 11)", async () => {
    const h = harness({ command: ["claude"], via: "direct" });
    const pane = t.tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "=main:", "-n", "running", "sleep 600").trim();
    claudeSession({ tmux: t, claudeDir: join(home.home, ".claude"), pane }).status("shell");   // running a shell command
    expect(await h.call("lane.stop", { name: "running" }, { key: "lanes:b2" })).toMatchObject({ ok: false, error: { code: "no_input_box", executed: "no" } });
    expect(windows()).toContain("running");
  });

  it("mode exit on a pane at a ❯ prompt with the shell in the foreground answers at once and types nothing", async () => {
    const h = harness({ command: ["claude"], via: "direct" });
    const pane = t.tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "=main:", "-n", "starship", SHELL).trim();
    t.tmux("send-keys", "-t", pane, "PS1='❯ '", "Enter");
    expect(await until(() => {
      const last = t.tmux("capture-pane", "-p", "-t", pane).split("\n").map(l => l.trim()).filter(Boolean).at(-1) ?? "";
      return last.endsWith("❯") && !/[$#%]$/.test(last);
    })).toBe(true);
    expect(show("display-message", "-p", "-t", pane, "#{pane_current_command}")).toBe("bash");
    expect(await h.call("lane.stop", { name: "starship" }, { key: "lanes:star" })).toMatchObject({ ok: true, result: { ok: true } });
    expect(windows()).toContain("starship");
    expect(t.tmux("capture-pane", "-p", "-t", pane)).not.toContain("/exit");
  });

  it("mode exit does not treat a blank starting screen as back at its shell", async () => {
    const h = harness({ command: ["claude"], via: "direct" });
    const pane = t.tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "=main:", "-n", "starting", "sleep 600").trim();
    expect(await h.call("lane.stop", { name: "starting" }, { key: "lanes:b3" })).toMatchObject({ ok: false, error: { code: "no_input_box", executed: "no" } });
    expect(windows()).toContain("starting");
    expect(t.tmux("capture-pane", "-p", "-t", pane)).not.toContain("/exit");
  });

  it("mode exit on a pane already at its shell answers at once and types nothing", async () => {
    const h = harness({ command: ["claude"], via: "direct" });
    const pane = t.tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "=main:", "-n", "bare", SHELL).trim();
    expect(await until(() => t.tmux("capture-pane", "-p", "-t", pane).includes("$"))).toBe(true);
    expect(await h.call("lane.stop", { name: "bare" }, { key: "lanes:b1" })).toMatchObject({ ok: true, result: { ok: true } });
    expect(windows()).toContain("bare");
    expect(t.tmux("capture-pane", "-p", "-t", pane)).not.toContain("/exit");
  });
});

describe("lane.start on an engine (reliable lanes §3.3)", () => {
  // The engine layer's CLI as a stand-in: on, and every role resolves to acme:large-2 after passing over beta.
  const enginesCli = () => {
    const path = join(bin, "engines");
    writeFileSync(path, `#!/bin/sh\n[ "$1" = option ] && { echo true; exit 0; }\necho '{"picked":{"entry":"acme:large-2"},"skipped":[{"entry":"beta:x@high","reason":"beta: not installed"}]}'\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const acme: Launch = { command: ["claude-as", "--model", "{model}", "--effort", "{effort}", "--window", "{lane}"], via: "direct" };

  it("a start that names nothing runs the default role's pick with the provider's launch, and says what ran", async () => {
    const h = harness({ command: ["claude-quick"], via: "direct" }, {}, { engines: { cli: enginesCli(), launch: { acme }, defaultRole: "implement" } });
    const r = await h.call("lane.start", { cwd: work, name: "eng" }, { key: "lanes:e1", timeoutMs: 30_000 });
    expect(r).toMatchObject({ ok: true, result: { engine: { entry: "acme:large-2", role: "implement", skipped: [{ entry: "beta:x@high", reason: "beta: not installed" }] } } });
    await until(() => argv("claude-as") !== null);
    expect(argv("claude-as")).toEqual(["claude-as", "--model", "large-2", "--window", "eng"]);
    expect(argv("claude-quick")).toBeNull();                                             // negative control: the node's own launch
  });

  it("a role whose provider has no launch command here is refused, and nothing starts", async () => {
    const h = harness({ command: ["claude-quick"], via: "direct" }, {}, { engines: { cli: enginesCli(), launch: {} } });
    const r = await h.call("lane.start", { cwd: work, name: "eng", role: "implement" }, { key: "lanes:e2", timeoutMs: 30_000 });
    expect(r).toMatchObject({ ok: false, error: { code: "denied", executed: "no" } });
    expect(windows()).not.toContain("eng");
  });
});
