// The tmux facts the agent acts on, each read with one tmux command (tmux(1), https://man7.org/linux/man-pages/man1/tmux.1.html,
// read 2026-10-06: list-panes -s, display-message -p, formats).
// - Every call goes through node-ops' tmuxArgv, so it passes `-u`: tmux writes UTF-8 only when the client's locale says
//   so, and an agent under a service manager must not depend on its locale (tmux-cli.ts).
// - Window names, paths and titles may hold tabs and newlines (they pass through raw with -u), so fields and records
//   are separated by markers built from a random nonce per call, which no name contains by accident.
// - A session target is exactSession(name), "=name": without "=" tmux also matches by prefix ("mai" finds "main").
//   Panes and windows are targeted by ID (%N, @N), never by name: a target's window part is matched as a pattern and
//   split at "." (plan Global Constraints, the tmux rules).
// - The -F formats here are built from fixed names and a random nonce, never from outside data.
// - display-message on a pane that doesn't exist exits 0 with an empty #{pane_id} (seen 2026-10-06; with a target that
//   matches nothing it even prints the session's current window), so a pane's facts count only when the pane_id read
//   back is the one asked for.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { exactSession, TmuxUnavailable, tmuxArgv, tmuxFailure } from "@morndo/node-ops";

const run = promisify(execFile);

// panePid: the pane's own process (#{pane_pid}): its shell, or the command a lane was started with.
// currentCommand: #{pane_current_command}, the foreground process's name (bash, zsh, fish, node, sleep).
export type PaneRow = { pane: string; paneNum: number; windowId: string; windowPanes: number; window: string; cwd: string; title: string | null; stamp: string;
  panePid: number | null; currentCommand: string };
export type PaneFacts = { session: string; windowPanes: number; window: string; stamp: string };

// SIGTERM leaves a stalled tmux client exiting 0 with empty output, so a timeout looked like success; SIGKILL cannot be
// caught, so the timeout is an error (Node child_process: killSignal; observed on tmux 3.6a, 2026-10-07).
export async function tmuxRun(socket: string | null, args: string[], timeout = 5000): Promise<string> {
  return (await run("tmux", tmuxArgv(socket, args), { timeout, killSignal: "SIGKILL", maxBuffer: 8 << 20 })).stdout;
}

function format(nonce: string, names: string[]): string {
  return `${names.map(n => `#{${n}}`).join(`<${nonce}>`)}</${nonce}>`;
}

function records(out: string, nonce: string, fields: number): string[][] {
  return out.split(`</${nonce}>\n`).filter(r => r.length > 0).map(r => r.split(`<${nonce}>`)).filter(f => f.length === fields);
}

// "8 hex of @morndo-server" (plan Contracts, stampServer): the first eight hex digits of the UUID stamped there.
const shortStamp = (v: string) => (/^[0-9a-f]{8}/.test(v) ? v.slice(0, 8) : "");

// [] only when tmux says there is no server or no session; a tmux that did not answer throws, so the inventory keeps
// what it had. A live session always has a pane, and every record ends with the nonce marker, so empty or cut-off output
// (exit 0, empty stdout after a stalled caller) is a failure too.
// Every pane of the policy's session, with its server's stamp ("" when not stamped yet); [] without a server or session.
export async function listPanes(socket: string | null, session: string): Promise<PaneRow[]> {
  const nonce = randomBytes(16).toString("hex");
  let out: string;
  try {
    out = await tmuxRun(socket, ["list-panes", "-s", "-t", exactSession(session), "-F",
      format(nonce, ["pane_id", "window_id", "window_panes", "@morndo-server", "host", "window_name", "pane_current_path", "pane_title", "pane_pid", "pane_current_command"])]);
  } catch (e) {
    if (tmuxFailure(e) === "absent") return [];
    throw new TmuxUnavailable("tmux list-panes did not answer", { cause: e });
  }
  if (out === "" || !out.endsWith(`</${nonce}>\n`)) throw new TmuxUnavailable("tmux list-panes answered with no complete record");
  return records(out, nonce, 10).flatMap(([pane = "", windowId = "", panes = "", stamp = "", host = "", window = "", cwd = "", title = "", pid = "", command = ""]) => {
    const m = /^%(\d{1,9})$/.exec(pane);
    if (!m || !/^@\d+$/.test(windowId)) return [];
    return [{ pane, paneNum: Number(m[1]), windowId, windowPanes: Number(panes), window, cwd, title: title && title !== host ? title : null, stamp: shortStamp(stamp),
      panePid: /^\d{1,10}$/.test(pid) ? Number(pid) : null, currentCommand: command.trim() }];
  });
}

// One pane's session, window and server stamp, read together; null when the pane doesn't exist or no tmux server runs
// there; "unavailable" when tmux did not answer (a stall, EMFILE), which says nothing about the pane.
export async function paneFacts(socket: string | null, pane: string): Promise<PaneFacts | null | "unavailable"> {
  if (!/^%\d{1,9}$/.test(pane)) return null;
  const nonce = randomBytes(16).toString("hex");
  let out: string;
  try {
    out = await tmuxRun(socket, ["display-message", "-p", "-t", pane, format(nonce, ["pane_id", "session_name", "window_panes", "@morndo-server", "window_name"])]);
  } catch (e) {
    return tmuxFailure(e) === "absent" ? null : "unavailable";
  }
  if (out === "") return "unavailable";
  const [r] = records(out, nonce, 5);
  if (!r || r[0] !== pane) return null;
  const [, session = "", panes = "", stamp = "", window = ""] = r;
  return { session, windowPanes: Number(panes), window, stamp: shortStamp(stamp) };
}
