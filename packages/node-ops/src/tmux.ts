// Terminal multiplexer adapter: lists panes, captures their text, and (ADR-0006) pastes a command into one; for fleet
// clients (docs/design/fleet-clients/README.md §5) also a capture of N lines with attributes, keys by name and the
// launcher's literal paste. Commands used (tmux(1), 3.4; the texts quoted below are tmux 3.6a's man page, read 2026-10-08,
// https://man7.org/linux/man-pages/man1/tmux.1.html): list-panes, capture-pane, and for sending load-buffer,
// paste-buffer, send-keys. Panes are targeted by ID (%N) only; no argument here is a format, so none needs tmuxLiteral.
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { promisify } from "node:util";
import { workerId, type Worker } from "@morndo/domain";
import { KEY_NAMES, LIMITS, type KeyName } from "@morndo/protocol";
import { tmuxArgv } from "./tmux-cli.ts";

const run = promisify(execFile);
// tmux prints control characters in formats as octal escapes ("\\037"), but passes a tab through.
const SEP = "\t";

// no_input_box: the pane shows no agent input box (its CLI exited to a shell, say), so nothing is typed there.
export type SendProblem = "menu_open" | "draft_present" | "no_input_box" | "not_submitted" | "no_pane" | "busy";   // busy: the pane lock

export type Tmux = {
  listWorkers(): Promise<Omit<Worker, "node">[]>;        // panes on this machine; the caller names their node (local-node.ts)
  // Without `o`, the hub's view: the history it was made with and the screen, plain. With `o` (pane.capture), the screen's
  // last `o.lines` lines (1 to LIMITS.captureMaxLines), with tmux's attribute escapes when `o.attributes`, and wrapped
  // lines joined unless `o.join` is false. null: no such pane, or a count out of range.
  capture(id: string, o?: { lines: number; attributes?: boolean; join?: boolean }): Promise<string | null>;
  // `engineLane`: the pane runs a lane of the engine layer (engine-sessions.ts), whose input line is the last line on screen
  // (engineLaneBoxOnScreen) and which has no menus. Only a caller that knows that from the lane's own registry says so: a
  // shell prompt can be drawn the same way.
  send(id: string, text: string, call?: { signal?: AbortSignal; engineLane?: boolean }): Promise<SendProblem | null>;
  // Keys by name (pane.keys `names`): true once tmux took them; false for a name off KEY_NAMES, no names or too many, a
  // pane that isn't one, or a tmux that failed.
  sendKeyNames(paneId: string, names: KeyName[]): Promise<boolean>;
  // The launcher's command line at a shell's prompt (`launch.via: "shell"`): pasted bracketed as one line, with no input-box
  // checks and no Enter (the caller presses it). Rejects when tmux fails.
  pasteLiteral(paneId: string, text: string): Promise<void>;
};

const KEYS = new Set<string>(KEY_NAMES);
const PANE_ID = /^%\d+$/;

// Text into a pane as one tmux command list, so no other tmux client's keys land between its parts: load it into a private
// buffer from stdin (load-buffer: "If path is '-', the contents are read from stdin"), paste it (-p: "paste bracket control
// codes are inserted around the buffer if the application has requested bracketed paste mode") and delete the buffer (-d),
// then `after`. The same 5 s bound as every other tmux call here; SIGKILL, because tmux's client exits 0 on SIGTERM, which
// would read as success.
function pasteText(socket: string | null, id: string, text: string, after: readonly string[]): Promise<void> {
  const buffer = `morndo-${randomUUID()}`;
  return new Promise<void>((resolve, reject) => {
    const p = spawn("tmux", tmuxArgv(socket, ["load-buffer", "-b", buffer, "-", ";", "paste-buffer", "-p", "-d", "-b", buffer, "-t", id, ...after]), { timeout: 5000, killSignal: "SIGKILL" });
    p.on("error", reject);
    p.on("exit", (code, signal) => (code === 0 ? resolve() : reject(new Error(`tmux exited ${code ?? signal}`))));
    p.stdin.on("error", () => { /* the exit handler reports it */ });
    p.stdin.end(text);
  });
}

// What an agent's terminal shows (Claude Code 2.1.286's interactive UI): a menu waiting for a choice, and the input
// line after "❯". The menu words follow the box's own lane-events-push guard.
const MENU = /Enter to (select|confirm)|Esc to cancel|Do you want to proceed|trust this folder/;
const SGR = /\x1b\[([0-9;]*)m/g;

// Claude Code's input box: a "❯" line directly under a ─ rule, in the bottom lines the draft is read from. A menu
// choice ("❯ 1. Yes") is not one, nor a past prompt in the history (drawn without a rule above it).
const BOX_WINDOW = 12;
const RULE = /^\s*╭?─/;
const PROMPT = /^[\s│]*❯(?!\s*\d+\.)/;
function inputBoxAt(lines: string[]): number {
  let end = lines.length;
  while (end > 0 && !lines[end - 1]?.trim()) end--;                 // the pane's empty bottom lines
  for (let i = end - 1; i >= Math.max(1, end - BOX_WINDOW); i--) {
    if (PROMPT.test(lines[i] ?? "") && RULE.test(lines[i - 1] ?? "")) return i;
  }
  return -1;
}
export const inputBoxOnScreen = (screen: string) => inputBoxAt(screen.replace(SGR, "").split("\n")) !== -1;

// The engine layer's lane (lane.py): its input is "❯ " and the text, always the last line on screen, with no rule above it
// and nothing under it (`say` prints above the line and draws it again). Not a menu choice ("❯ 1. Yes").
export function engineLaneBoxOnScreen(screen: string): boolean {
  const lines = screen.replace(SGR, "").split("\n");
  let end = lines.length;
  while (end > 0 && !lines[end - 1]?.trim()) end--;
  return end > 0 && PROMPT.test(lines[end - 1] ?? "");
}

// A menu replaces the input box, so with a box on screen only what is below it can be a menu: menu words in the agent's
// own prose above the box are not one. With no box, the menu words anywhere in the last 25 lines.
export function menuOnScreen(screen: string) {
  const lines = screen.replace(SGR, "").split("\n");
  const box = inputBoxAt(lines);
  return MENU.test((box === -1 ? lines.slice(-25) : lines.slice(box + 1)).join("\n"));
}

// A menu on the screen as an identity (ADR-0008 phase C, S6): a digest of the menu itself, without colours or blank
// lines, or null when no menu shows. Another menu, or the highlight moved, is another identity.
export function menuIdentity(screen: string): string | null {
  if (!menuOnScreen(screen)) return null;
  const lines = screen.replace(SGR, "").split("\n");
  const box = inputBoxAt(lines);
  const region = (box === -1 ? lines.slice(-25) : lines.slice(box + 1)).map(l => l.trimEnd()).filter(l => l.trim());
  // Only the menu: its question (the line above the first numbered choice) down to the end, so output or a status line
  // above it that keeps changing doesn't change it (review L2). Without numbered choices, its last lines.
  const first = region.findIndex(l => /^\s*(?:[❯>]\s*)?\d+\.\s/.test(l));
  const menu = first === -1 ? region.slice(-6) : region.slice(Math.max(0, first - 1));
  return createHash("sha256").update(menu.join("\n")).digest("hex").slice(0, 16);
}

// The text typed after "❯", from a capture with colors (capture-pane -e). After a turn Claude Code shows a suggested
// next prompt as dim ghost text (SGR 2; "Prompt suggestions", promptSuggestionEnabled, default on), which plain text
// can't tell from a draft. Only text that isn't dim counts. Plain captures (no escapes) still work.
//
// 38/48/58 take colour arguments (indexed 5;n or direct 2;r;g;b). Those numbers are not the dim/reverse flags, even
// when a component is 2, 7, 22 or 27. xterm ctlseqs (ISO-8613-6; semicolon form from konsole) and kitty's underline
// colour, which uses the same shape as 38 and 48. Colon-form parameters (ECMA-48, `4:3` for a curly underline) and
// OSC 8 hyperlinks are the same kind of styling: tmux 3.4 `capture-pane -e` emits both, and neither is typed text.
function applySgr(params: string, style: { dim: boolean; rev: boolean }) {
  const codes = (params === "" ? "0" : params).split(";");
  let i = 0;
  while (i < codes.length) {
    const code = codes[i] ?? "";
    if (code === "38" || code === "48" || code === "58") {
      const mode = codes[i + 1];
      // Indexed and direct colour have a fixed shape. Any other selector (empty, or 3 and above) introduces
      // a run of components; those numbers are not dim or reverse.
      if (mode === "5") { i += 3; continue; }
      if (mode === "2") { i += 5; continue; }
      return;
    }
    if (code === "0" || code === "") { style.dim = false; style.rev = false; }
    else if (code === "7") style.rev = true;
    else if (code === "27") style.rev = false;
    else if (code === "2") style.dim = true;
    else if (code === "22") style.dim = false;
    i++;
  }
}

// CSI ends at its final byte (0x40-0x7e). A final `m` is SGR; anything else is skipped. OSC ends at BEL or ST.
function takeCsi(text: string, i: number, style: { dim: boolean; rev: boolean }): number {
  const start = i;
  while (i < text.length) {
    const d = text.charCodeAt(i);
    if (d >= 0x40 && d <= 0x7e) {
      if (d === 0x6d) applySgr(text.slice(start, i), style);
      return i + 1;
    }
    i++;
  }
  return text.length;
}
function takeOsc(text: string, i: number): number {
  while (i < text.length) {
    const d = text.charCodeAt(i);
    if (d === 0x07 || d === 0x9c) return i + 1;
    if (d === 0x1b && text.charCodeAt(i + 1) === 0x5c) return i + 2;
    i++;
  }
  return text.length;
}

export function draftOnScreen(screen: string): string | null {
  const line = screen.split("\n").slice(-12).reverse().find(l => /^[\s│]*❯/.test(l.replace(SGR, "")));
  if (!line) return null;
  const after = line.slice(line.indexOf("❯") + 1);
  // Claude Code draws the cursor as reverse video on one cell. On a dim placeholder or suggestion that cell is the
  // first character and is not itself dim, so it would look typed. A one-character reverse run takes the dim state
  // of the text after it (nothing after it counts as typed: a one-character draft, or the cursor at the end). A
  // longer reverse run is the text itself — a selection or a pasted chip — and is kept.
  const style = { dim: false, rev: false };
  const runs: { text: string; dim: boolean; rev: boolean }[] = [];
  let buf = "";
  const flush = () => { if (buf) runs.push({ text: buf, dim: style.dim, rev: style.rev }); buf = ""; };
  for (let i = 0; i < after.length;) {
    const c = after.charCodeAt(i);
    if (c !== 0x1b && c !== 0x9b && c !== 0x9d) { buf += after[i]; i++; continue; }
    flush();
    if (c === 0x9b) { i = takeCsi(after, i + 1, style); continue; }
    if (c === 0x9d) { i = takeOsc(after, i + 1); continue; }
    const next = after.charCodeAt(i + 1);
    if (next === 0x5b) i = takeCsi(after, i + 2, style);
    else if (next === 0x5d) i = takeOsc(after, i + 2);
    else i += next >= 0x40 && next <= 0x5f ? 2 : 1;
  }
  flush();
  let typed = "";
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (!run || run.dim) continue;
    if (run.rev && Array.from(run.text).length === 1 && runs[i + 1]?.dim) continue;
    typed += run.text;
  }
  const draft = typed.replace(/\s*│\s*$/, "").trim();
  // 'Try "…"' is the empty box's placeholder. Claude Code draws it dim, so with colors the dim check has already left it
  // out, and a typed 'Try "…"' is a real draft. Only a plain capture needs the wording rule.
  const colored = screen.includes("\x1b[");
  return draft && (colored || !/^Try "/.test(draft)) ? draft : null;
}

// The draft keeps the reverse-video cursor cell, so a box that differs by one character is not this paste. The first
// 20 code points are the whole short paste, or the start of a longer one. Leading space is ignored on both sides:
// draftOnScreen trims the box.
function draftStillWaiting(sent: string, draft: string): boolean {
  // A long paste is folded into one chip: "[Pasted text #1 +12 lines]" for several lines, "[Pasted text #1]" for one long
  // line (Claude Code 2.1.305, seen with 100,000 characters). The chip is the paste, still in the box, when its form
  // fits the text; a short one-line paste is never folded.
  if (/^\[Pasted text #\d+ \+\d+ lines\]$/.test(draft)) return sent.includes("\n");
  if (/^\[Pasted text #\d+\]$/.test(draft)) return !sent.includes("\n");
  const sentPoints = Array.from(sent.trim());
  const head = sentPoints.slice(0, 20);
  const shown = Array.from(draft).slice(0, 20);
  return shown.length === head.length && shown.every((c, i) => c === head[i]);
}

// The box still holds what was just pasted (the paste's own start, or the chip a multi-line paste is folded into).
export function notSubmitted(sent: string, draft: string | null): boolean {
  return draft !== null && draft !== "" && draftStillWaiting(sent, draft);
}

export function tmuxAdapter(opts: { socket: string | null; session: string | null; historyLines?: number }): Tmux {
  const history = opts.historyLines ?? 150;
  const tmux = async (args: string[]) => (await run("tmux", tmuxArgv(opts.socket, args), { timeout: 5000, maxBuffer: 4 << 20 })).stdout;

  // The bottom of a pane with its colors, for the input line checks.
  const styled = async (id: string) => {
    try {
      const lines = (await tmux(["capture-pane", "-p", "-e", "-t", id, "-S", "-30"])).split("\n");
      while (lines.length && !lines.at(-1)?.replace(SGR, "").trim()) lines.pop();   // the pane's empty bottom lines
      return lines.join("\n");
    } catch { return null; }
  };

  return {
    async listWorkers() {
      const fmt = ["#{pane_id}", "#{session_name}", "#{window_index}", "#{window_name}", "#{pane_current_path}"].join(SEP);
      let out: string;
      try {
        out = await tmux(["list-panes", "-a", "-F", fmt]);
      } catch {
        return [];                                        // no tmux server running: no workers
      }
      return out.split("\n").filter(Boolean).flatMap(line => {
        const [pane = "", session = "", index = "", name = "", ...rest] = line.split(SEP);
        const path = rest.join(SEP);
        if (!/^%\d+$/.test(pane)) return [];
        if (opts.session && session !== opts.session) return [];
        return [{ id: workerId(pane), name: name || `${session}:${index}`, location: basename(path) || path }];
      });
    },
    async send(id, text, call) {
      if (!/^%\d+$/.test(id)) return "no_pane";
      const before = await styled(id);
      if (before === null) return "no_pane";
      const engine = call?.engineLane === true;
      if (!engine && menuOnScreen(before)) return "menu_open";          // an engine lane draws no menu; its prose may hold the words
      if (!(engine ? engineLaneBoxOnScreen(before) : inputBoxOnScreen(before))) return "no_input_box";
      if (draftOnScreen(before)) return "draft_present";
      // Control characters other than newline and tab are dropped: tmux pastes the bytes as they are, so an ESC[201~ in
      // the text would end the bracketed paste early and the rest would arrive as key presses.
      const clean = text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
      call?.signal?.throwIfAborted();             // the deadline's last word: nothing is pasted after it
      await pasteText(opts.socket, id, clean, [";", "send-keys", "-t", id, "Enter"]);
      await new Promise(r => setTimeout(r, 400));
      const after = await styled(id);
      const draft = after ? draftOnScreen(after) : null;
      return notSubmitted(clean, draft) ? "not_submitted" : null;
    },
    async capture(id, o) {
      if (!/^%\d+$/.test(id)) return null;
      if (o && (!Number.isInteger(o.lines) || o.lines < 1 || o.lines > LIMITS.captureMaxLines)) return null;
      try {
        if (!o) {
          const out = await tmux(["capture-pane", "-p", "-J", "-t", id, "-S", `-${history}`]);
          return out.split("\n").map(l => l.trimEnd()).join("\n").replace(/\n+$/, "");
        }
        // -S: "negative numbers are lines in the history", so -S -N is N lines of history and the visible pane; -J "joins
        // any wrapped lines" (as kira reads screen text; left out when `join` is false); -e "includes escape sequences for
        // text and background attributes". The pane's empty bottom lines go first (blank once their escapes are left out),
        // then the last N lines are what was asked for.
        const out = await tmux(["capture-pane", "-p", ...(o.join === false ? [] : ["-J"]), ...(o.attributes ? ["-e"] : []), "-t", id, "-S", `-${o.lines}`]);
        const lines = out.split("\n").map(l => l.trimEnd());
        while (lines.length && !lines.at(-1)?.replace(SGR, "").trim()) lines.pop();
        return lines.slice(-o.lines).join("\n");
      } catch {
        return null;                                      // the pane went away between list and capture
      }
    },
    async sendKeyNames(paneId, names) {
      // send-keys: "Each argument key is the name of the key (such as 'C-a' or 'NPage') to send"; one argument per name,
      // never -l ("disables key name lookup"). The allow-list is checked again here, right before tmux sees the names.
      if (!PANE_ID.test(paneId) || names.length === 0 || names.length > LIMITS.maxKeys || !names.every(n => KEYS.has(n))) return false;
      try { await tmux(["send-keys", "-t", paneId, ...names]); return true; }
      catch { return false; }
    },
    async pasteLiteral(paneId, text) {
      if (!PANE_ID.test(paneId)) throw new Error(`not a pane ID: ${JSON.stringify(paneId)}`);
      // One line: every control character is dropped, a newline too. paste-buffer replaces "any linefeed (LF) characters
      // in the paste buffer ... by default [with] carriage return (CR)", which a shell without bracketed paste would run.
      let line = "";
      for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); if (c >= 0x20 && c !== 0x7f) line += text.charAt(i); }
      await pasteText(opts.socket, paneId, line, []);
    },
  };
}
