// Terminal adapter: a worker's pane as tmux draws it, frame by frame, and (under control, AC9) keys typed into it.
// Frames come from capture-pane with its colors (-e) plus the cursor and size from display-message, in one tmux command
// list. Nothing attaches as a client, so no window is resized or switched for anyone else watching the same session.
// Keys go in with send-keys: ASCII as hex bytes (-H), anything else as literal UTF-8 (-l), so escape sequences from the
// browser's terminal (arrows, Ctrl keys, Enter as CR) arrive exactly as typed. tmux(1) 3.4: capture-pane, display-message,
// send-keys.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LIMITS } from "@morndo/protocol";
import { tmuxArgv, tmuxFailure } from "./tmux-cli.ts";

const run = promisify(execFile);

export type Frame = { cols: number; rows: number; x: number; y: number; cursor: boolean; lines: string[] };
// "unavailable" is a tmux that did not answer now; null is a pane that is gone (the hub's ports.ts:73-74).
// `guard`: the pane is the one meant only if its session and its server stamp (the first eight hex digits of @morndo-server)
// are these; read in the same tmux command as the frame, so a guarded frame is one spawn, not two. Otherwise null.
export type FrameGuard = { session: string; server: string };
export type Terminal = { frame(id: string, guard?: FrameGuard): Promise<Frame | null | "unavailable">; keys(id: string, data: string): Promise<boolean> };

export const MAX_KEYS = LIMITS.maxKeys;

// tmux arguments for typing `data` into a pane: one send-keys per run of ASCII or non-ASCII text, as one command list.
export function keyArgs(id: string, data: string): string[] {
  const args: string[] = [];
  let hex: string[] = [];
  let literal = "";
  const flush = () => {
    if (hex.length) { if (args.length) args.push(";"); args.push("send-keys", "-t", id, "-H", ...hex); hex = []; }
    if (literal) { if (args.length) args.push(";"); args.push("send-keys", "-t", id, "-l", literal); literal = ""; }
  };
  for (const ch of data) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 128) { if (literal) flush(); hex.push(code.toString(16).padStart(2, "0")); }
    else { if (hex.length) flush(); literal += ch; }
  }
  flush();
  return args;
}

export function terminalAdapter(opts: { socket: string | null }): Terminal {
  return {
    async frame(id, guard) {
      if (!/^%\d+$/.test(id)) return null;
      let out: string;
      try {
        out = (await run("tmux", tmuxArgv(opts.socket, ["capture-pane", "-p", "-e", "-t", id, ";", "display-message", "-p", "-t", id,
          "#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{cursor_flag} #{@morndo-server} #{session_name}"]), { timeout: 3000, killSignal: "SIGKILL", maxBuffer: 4 << 20 })).stdout;
      } catch (e) {
        return tmuxFailure(e) === "absent" ? null : "unavailable";   // the pane went away, or tmux did not answer
      }
      if (out === "") return "unavailable";                           // exit 0 with nothing: not a frame
      const lines = out.replace(/\n$/, "").split("\n");
      const fields = (lines.pop() ?? "").split(" ");              // five numbers, the server's stamp (may be empty), the session
      const meta = fields.slice(0, 5).map(Number);
      const [cols = 80, rows = 24, x = 0, y = 0, flag = 1] = meta;
      if (meta.length < 5 || meta.some(n => !Number.isFinite(n))) return null;
      if (guard && (fields.slice(6).join(" ") !== guard.session || !/^[0-9a-f]{8}/.test(fields[5] ?? "") || (fields[5] ?? "").slice(0, 8) !== guard.server)) return null;
      const screen = lines.slice(0, rows);
      while (screen.length < rows) screen.push("");
      return { cols, rows, x, y, cursor: flag === 1, lines: screen };
    },
    async keys(id, data) {
      if (!/^%\d+$/.test(id) || !data || data.length > MAX_KEYS) return false;
      try { await run("tmux", tmuxArgv(opts.socket, keyArgs(id, data)), { timeout: 3000 }); return true; }
      catch { return false; }
    },
  };
}
