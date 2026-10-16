// lane.start and lane.stop (fleet core §4 "Lane names", §5.3, §8; fleet clients spec §5): typed fields only, never free
// flags or a shell line from the op. A lane is a tmux window in the policy's session, and its name is unique on this node.
// - The launcher is the node owner's setting (policy.launch). `{account}` in its words is the op's account, and `resume`
//   adds `--resume <session>`; an op can add nothing else (spec §11). A command without `{account}` refuses an op that
//   names one (bad_args); a command with it refuses an op that names none. A start by role or engine runs the policy's
//   launch command for that engine's provider instead (lane-engine.ts, reliable lanes §3.3).
// - via "direct": tmux runs the command's words as the pane's program, without `sh -c` (tmux(1) new-window: "shell-command
//   given as multiple arguments and executed directly", read 2026-10-06).
// - via "shell": the window starts with no command, so tmux starts the user's shell (tmux(1) default-command: "The default
//   is an empty string, which instructs tmux to create a login shell using the value of the default-shell option",
//   https://man7.org/linux/man-pages/man1/tmux.1.html, read 2026-10-08). Once its screen has settled (its prompt drawn, as
//   `lanes start` waits) or 10 s have passed (a shell reads what was typed once it is ready), the command is pasted as one
//   literal line (Task 2's pasteLiteral: load-buffer, then paste-buffer -p, which brackets the paste only "if the
//   application has requested bracketed paste mode", tmux 3.6a's tmux(1)), and Enter is pressed. The window outlives
//   Claude Code, and claude-pool can move the lane. pane.send can't type it: at a shell it refuses no_input_box, which is
//   right for everyone else (spec §5). Each word is single-quoted for the shell unless it is plainly safe.
// - Folder trust: after starting, the agent looks at the new pane for Claude Code's trust dialog until Claude Code shows
//   its box, for up to 10 s. Seen, the answer carries `waiting: "trust"`; accepting it stays the client's
//   decision (spec §5). Its words are pinned by the real 2.1.287 screen
//   (packages/node-ops/test/fixtures/claude-code-2.1.287/trust-dialog.ansi).
// - A first prompt becomes a delivery to the new pane (spec §5), with the id `<client>:prompt:<first 16 hex of SHA-256 of
//   the start's key>` (RECONCILIATION.md ruling 7; always within 200 characters). The pane's process has just started, so it
//   is in the deliverer's 2-minute grace (ruling 14): the delivery waits for Claude Code (no_session) and is typed once
//   the lane can take it.
// - tmux expands formats in -n and -c, so the name and the directory go through tmuxLiteral, and the session through
//   exactSession. The window to stop is targeted by its ID (@N) from the inventory, never by its name.
// - lane.stop refuses the policy's protected names (`denied`). mode "kill" closes the window. mode "exit" (the default):
//   - types `/exit` through pane.send under `<key>:exit`, with every check a delivery has (never into a menu or over a
//     draft);
//   - answers Claude Code's "Exit and stop tasks" prompt with 1, as claude-pool does (its real screen is still to be
//     recorded, RECONCILIATION.md ruling 19);
//   - answers once the window has closed or the pane is back at its shell, or `uncertain` after 30 s
//     (LIMITS.laneStopWaitMs).
//   A pane already at its shell (no live Claude Code session there, whatever a session's `status` said: ruling 11; no box
//   and no menu, and the pane's foreground process is the shell) is answered at once. A blank or loading screen is
//   still starting, so /exit is typed. The prompt's last character is not the test: starship and pure end in ❯,
//   oh-my-zsh in ➜, and fish in >.
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { LIMITS, formatWorkerId, parseWorkerId, type OpArgs, type OpError, type OpResult } from "@morndo/protocol";
import { deniedBy, denyConfigFromEnv, denyRoots, engineLaneBoxOnScreen, exactSession, hostTmuxServer, inputBoxOnScreen, menuOnScreen, resolvedRoots, tmuxLiteral, type PanePids, type SessionInfo, type Tmux } from "@morndo/node-ops";
import type { Policy } from "../config.ts";
import { engineLayer, laneLaunch, type EngineLayer } from "./lane-engine.ts";
import { effect, fail, ok, type EffectContext, type OpTable, type Outcome, type Reply, type Request } from "./executor.ts";
import type { Inventory, Lane } from "./inventory.ts";
import { listPanes, panePidsOf, tmuxRun } from "./tmux-panes.ts";

// How long lane.start and lane.stop wait, each also bounded by the op's own deadline. Tests shorten them.
export type LaneWaits = { pollMs: number; shellMs: number; trustMs: number; stopMs: number };
export const LANE_WAITS: LaneWaits = { pollMs: 250, shellMs: 10_000, trustMs: 10_000, stopMs: LIMITS.laneStopWaitMs };

export type LaneDeps = {
  node: string;
  policy: Policy;
  inventory: Inventory;
  home: string;
  stateDir: string;
  stamp: (socket: string | null) => Promise<string | null>;
  tmux: Pick<Tmux, "capture" | "pasteLiteral" | "sendKeyNames">;
  send: (req: Request) => Promise<Reply>;                                          // the agent's executor (pane.send, pane.keys)
  deliver: (a: OpArgs["lane.deliver"]) => OpResult["lane.deliver"] | OpError;    // the deliverer's enqueue
  waits?: Partial<LaneWaits>;
  host?: (opts: { socket: string | null }) => Promise<unknown>;                   // starts the tmux server outside this service
  engines?: EngineLayer;                                                          // the engine layer's CLI (lane-engine.ts)
  sessions: (panes: PanePids) => Map<string, SessionInfo>;                        // the sessions in the panes (an engine lane is looked for in them)
};

export { launchCommand } from "./lane-engine.ts";

const TRUST = /Yes, I trust this folder|Do you trust the files in this folder/;
export const trustDialogOnScreen = (screen: string): boolean => TRUST.test(screen);
const EXIT_PROMPT = /Exit and stop tasks/;
const SAFE_WORD = /^[A-Za-z0-9_./:@+=,-]+$/;
// #{pane_current_command} when the pane is sitting at a prompt. A login shell is sometimes "-bash".
const SHELL_COMMANDS = new Set(["ash", "bash", "csh", "dash", "elvish", "fish", "ksh", "mksh", "nu", "powershell", "pwsh", "sh", "tcsh", "xonsh", "zsh"]);
const shellInForeground = (command: string): boolean => SHELL_COMMANDS.has(command.split("/").at(-1)?.replace(/^-/, "") ?? "");

// The command as one line for a POSIX shell: a plainly safe word as it is, any other single-quoted.
export function shellLine(words: readonly string[]): string {
  return words.map(w => (SAFE_WORD.test(w) ? w : `'${w.replaceAll("'", "'\\''")}'`)).join(" ");
}

// A first prompt's delivery id (ruling 7): the start's client (its key's namespace), "prompt", and the first 16 hex digits
// of the SHA-256 of the start's key. Within 200 characters whatever the key, and never ending in "#<digits>".
export function promptId(key: string): string {
  const client = /^[a-z]{1,16}:/.exec(key)?.[0] ?? "lane:";
  return `${client}prompt:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function realDir(p: string): string | null {
  try {
    const real = realpathSync(p);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

// A wait's length: its own limit, and never past the op's deadline less what must still follow it.
const within = (ctx: EffectContext, ms: number, reserve: number): number => Math.max(0, Math.min(ms, ctx.remainingMs() - reserve));

export function laneOps(d: LaneDeps): Pick<OpTable, "lane.start" | "lane.stop"> {
  const socket = d.policy.tmuxSocket;
  const session = d.policy.session;
  const host = d.host ?? hostTmuxServer;
  const layer = d.engines ?? engineLayer();
  const w: LaneWaits = { ...LANE_WAITS, ...d.waits };
  // The cwd is judged resolved (realDir), so the deny roots are too, at each start: under a HOME that is a symbolic
  // link, "~/.ssh" as given never prefixes the real path of a directory in it (final review M10).
  const deny = () => resolvedRoots(denyRoots(d.home, d.stateDir, denyConfigFromEnv(process.env)));
  const sessionExists = async () => {
    try { await tmuxRun(socket, ["has-session", "-t", exactSession(session)]); return true; }
    catch { return false; }
  };
  const screen = (pane: string) => d.tmux.capture(pane, { lines: 50, attributes: false });
  // Only what the pane shows now (capture-pane without -S: "The default is to capture only the visible contents of the
  // pane", tmux(1) 3.6a). A box cleared away at /exit can sit in the history just above the shell's prompt: tmux's
  // scroll-on-clear, on by default, scrolls "the contents of the screen into history before clearing it".
  const visible = async (pane: string): Promise<string | null> => {
    try { return await tmuxRun(socket, ["capture-pane", "-p", "-t", pane]); } catch { return null; }
  };

  // A new shell has drawn its prompt once its screen holds something and stays the same for one poll (rc files done).
  async function settled(pane: string, ms: number): Promise<boolean> {
    const end = performance.now() + ms;
    let last: string | null = null;
    while (performance.now() < end) {
      const shown = await screen(pane);
      if (shown !== null && shown.trim() !== "" && shown === last) return true;
      last = shown;
      await sleep(w.pollMs);
    }
    return false;
  }

  // The trust dialog on the new pane, looked for until Claude Code shows its box, or the time is up. A session file proves
  // nothing here: Claude Code may write one while its dialog still shows.
  async function engineLaneIn(pane: string): Promise<boolean> {
    try { return d.sessions(panePidsOf(await listPanes(socket, session))).get(pane)?.engine !== undefined; }
    catch { return false; }
  }

  async function sawTrust(pane: string, ms: number): Promise<boolean> {
    const end = performance.now() + ms;
    let askedAt = Number.NEGATIVE_INFINITY;
    for (;;) {
      const shown = await screen(pane);
      if (shown !== null && trustDialogOnScreen(shown)) return true;
      if (shown === null || inputBoxOnScreen(shown)) return false;
      // An engine lane has no trust dialog: its input line, with the lane in the engine registry, ends the look. A shell prompt
      // drawn as ❯ looks the same, so that is asked at most once a second, with one tmux list-panes and not an inventory read.
      if (engineLaneBoxOnScreen(shown) && performance.now() - askedAt >= 1000) {
        askedAt = performance.now();
        if (await engineLaneIn(pane)) return false;
      }
      if (performance.now() >= end) return false;
      await sleep(w.pollMs);
    }
  }

  // Where a lane stands after /exit: its window closed ("gone"); back at its shell (no live Claude Code session there,
  // whatever a status said: ruling 11; no box and no menu, and the foreground process is the shell: true); or still in
  // Claude Code, including a blank screen while it is still starting (false).
  async function standing(windowId: string): Promise<"gone" | boolean> {
    const snap = await d.inventory.refresh();
    const lane = snap.lanes.find(l => l.windowId === windowId);
    if (!lane) return snap.rows.some(r => r.windowId === windowId) ? false : "gone";
    if (lane.sessionId !== null) return false;
    const shown = await visible(lane.pane);
    if (shown === null || shown.trim() === "" || inputBoxOnScreen(shown) || menuOnScreen(shown)) return false;
    const command = snap.rows.find(r => r.pane === lane.pane)?.currentCommand ?? "";
    return shellInForeground(command);
  }

  async function exit(lane: Lane, ctx: EffectContext): Promise<Outcome<"lane.stop">> {
    if ((await standing(lane.windowId)) !== false) return ok<"lane.stop">({ ok: true });   // closed, or no Claude Code there
    const ref = parseWorkerId(lane.workerId);
    if (ref === null || ctx.key === undefined) return fail("internal", "lane.stop could not name the pane to type /exit into");
    const expect = { server: ref.server, window: lane.window };
    const typed = await d.send({
      id: "lane-stop-exit", op: "pane.send", args: { workerId: lane.workerId, text: "/exit", expect },
      timeoutMs: Math.max(1000, Math.floor(ctx.remainingMs())), key: `${ctx.key}:exit`,
    });
    if (!typed.ok && typed.error.executed === "no") return { ok: false, error: typed.error };
    const end = performance.now() + within(ctx, w.stopMs, 250);
    let answered = false;
    while (performance.now() < end) {
      await sleep(w.pollMs);
      if ((await standing(lane.windowId)) !== false) return ok<"lane.stop">({ ok: true });
      if (answered) continue;
      const shown = await screen(lane.pane);
      if (shown === null || !EXIT_PROMPT.test(shown)) continue;
      const r = await d.send({ id: "lane-stop-answer", op: "pane.keys", args: { workerId: lane.workerId, names: ["1"], expect }, timeoutMs: 5000 });
      answered = r.ok && (r.result as OpResult["pane.keys"]).ok;
    }
    return fail("uncertain", "after /exit the lane neither closed nor came back to its shell in time");
  }

  return {
    "lane.start": effect(a => `lane:${a.name}`, async (a, ctx) => {
      const cwd = realDir(a.cwd);
      if (!cwd) return fail("bad_args", "cwd is not a directory on this node");
      if (deniedBy(cwd, deny())) return fail("denied", "lanes may not start in that directory");
      const firstPrompt = ctx.key === undefined ? undefined : promptId(ctx.key);
      if (a.prompt !== undefined && firstPrompt === undefined) return fail("bad_args", "lane.start needs its key to queue a first prompt");
      const snap = await d.inventory.refresh();
      if (snap.rows.some(r => r.window === a.name)) return fail("name_taken", "a window of that name already exists on this node");
      // What it runs (lane-engine.ts): the node's launch, or an engine by role or by name. A refusal started nothing.
      const picked = await laneLaunch(d.policy, a, layer);
      if ("refused" in picked) return { ok: false, error: picked.refused };
      const { command } = picked;
      const exists = await sessionExists();
      // Host before the deadline check. A failure here started nothing, so the key is released.
      if (!exists) {
        try { await host({ socket }); }
        catch { return { ok: false, error: { code: "internal", executed: "no", message: "the tmux server could not be started outside this service" } }; }
      }
      const late = ctx.ready();
      if (late) return { ok: false, error: late };
      const shell = picked.via === "shell";
      const where = exists ? ["new-window", "-d", "-t", `${exactSession(session)}:`] : ["new-session", "-d", "-s", tmuxLiteral(session)];
      const out = await tmuxRun(socket, [...where, "-n", tmuxLiteral(a.name), "-c", tmuxLiteral(cwd), "-P", "-F", "#{pane_id}", ...(shell ? [] : command)]);
      const m = /^%(\d{1,9})$/.exec(out.trim());
      if (!m) return fail("internal", "tmux did not report the new pane");
      const pane = `%${m[1]}`;
      const stamp = await d.stamp(socket);
      if (!stamp) return fail("internal", "the tmux server could not be stamped");
      const workerId = formatWorkerId({ node: d.node, server: stamp, pane: Number(m[1]) });
      if (shell) {
        await settled(pane, within(ctx, w.shellMs, 4000));
        await d.tmux.pasteLiteral(pane, shellLine(command));
        await d.tmux.sendKeyNames(pane, ["Enter"]);
      }
      await d.inventory.refresh();                           // so this answer's invVersion already lists the new lane
      let prompt: string | undefined;
      if (a.prompt !== undefined && firstPrompt !== undefined) {
        const r = d.deliver({ id: firstPrompt, target: { workerId }, text: a.prompt });
        if ("code" in r) return fail("internal", `the lane started, but its first prompt was not queued (${r.code}: ${r.message})`);
        prompt = r.delivery.id;
      }
      const trust = await sawTrust(pane, within(ctx, w.trustMs, 1000));
      return ok<"lane.start">({
        workerId, ...(trust ? { waiting: "trust" as const } : {}), ...(prompt !== undefined ? { prompt } : {}), ...(picked.engine ? { engine: picked.engine } : {}),
      });
    }),

    "lane.stop": effect(a => `lane:${a.name}`, async (a, ctx) => {
      if (d.policy.protected.includes(a.name)) return fail("denied", "this node's policy protects that lane from lane.stop");
      const snap = await d.inventory.refresh();
      const lanes = snap.lanes.filter(l => l.window === a.name);
      const windows = [...new Set(lanes.map(l => l.windowId))];
      if (windows.length === 0) return fail("no_pane", "no lane of that name on this node");
      if (windows.length > 1) return fail("bad_args", "two windows on this node have that name; stop one in tmux");
      const late = ctx.ready();
      if (late) return { ok: false, error: late };
      if (a.mode === "kill") {
        await tmuxRun(socket, ["kill-window", "-t", windows[0] as string]);
        await d.inventory.refresh();
        return ok<"lane.stop">({ ok: true });
      }
      return exit(lanes[0] as Lane, ctx);
    }),
  };
}
