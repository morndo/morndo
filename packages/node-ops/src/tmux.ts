// Terminal multiplexer adapter: lists panes, captures their text, and (ADR-0006) pastes a command into one.
// Commands used (tmux(1), 3.4): list-panes, capture-pane, and for sending load-buffer, paste-buffer, send-keys.
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { promisify } from "node:util";
import { workerId, type Worker } from "@morndo/domain";
import { tmuxArgv } from "./tmux-cli.ts";

const run = promisify(execFile);
// tmux prints control characters in formats as octal escapes ("\\037"), but passes a tab through.
const SEP = "\t";

// no_input_box: the pane shows no agent input box (its CLI exited to a shell, say), so nothing is typed there.
export type SendProblem = "menu_open" | "draft_present" | "no_input_box" | "not_submitted" | "no_pane" | "busy";   // busy: the pane lock

export type Tmux = {
  listWorkers(): Promise<Omit<Worker, "node">[]>;        // panes on this machine; the caller names their node (local-node.ts)
  capture(id: string): Promise<string | null>;
  send(id: string, text: string, call?: { signal?: AbortSignal }): Promise<SendProblem | null>;
};

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
// colour, which uses the same shape as 38 and 48.
function applySgr(params: string, style: { dim: boolean; rev: boolean }) {
  const codes = (params === "" ? "0" : params).split(";");
  let i = 0;
  while (i < codes.length) {
    const code = codes[i] ?? "";
    if (code === "38" || code === "48" || code === "58") {
      const mode = codes[i + 1];
      i += mode === "5" ? 3 : mode === "2" ? 5 : mode === undefined ? 1 : 2;
      continue;
    }
    if (code === "0" || code === "") { style.dim = false; style.rev = false; }
    else if (code === "7") style.rev = true;
    else if (code === "27") style.rev = false;
    else if (code === "2") style.dim = true;
    else if (code === "22") style.dim = false;
    i++;
  }
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
  for (const m of after.matchAll(/\x1b\[([0-9;]*)m|([^\x1b]+)/g)) {
    if (m[1] !== undefined) applySgr(m[1], style);
    else if (m[2] !== undefined) runs.push({ text: m[2], dim: style.dim, rev: style.rev });
  }
  let typed = "";
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (!run || run.dim) continue;
    if (run.rev && [...run.text].length === 1) {
      const follow = runs.slice(i + 1).find(r => r.text !== "");
      if (follow?.dim) continue;
    }
    typed += run.text;
  }
  const draft = typed.replace(/\s*│\s*$/, "").trim();
  // 'Try "…"' is the empty box's placeholder. Claude Code draws it dim, so with colors the dim check has already left it
  // out, and a typed 'Try "…"' is a real draft. Only a plain capture needs the wording rule.
  const colored = screen.includes("\x1b[");
  return draft && (colored || !/^Try "/.test(draft)) ? draft : null;
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
      if (menuOnScreen(before)) return "menu_open";
      if (!inputBoxOnScreen(before)) return "no_input_box";
      if (draftOnScreen(before)) return "draft_present";
      // Control characters other than newline and tab are dropped: tmux pastes the bytes as they are, so an ESC[201~ in
      // the text would end the bracketed paste early and the rest would arrive as key presses.
      const clean = text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
      // One command list, so no other tmux client's keys land between paste and Enter: load the text into a private
      // buffer from stdin, paste it bracketed (-p) and delete the buffer (-d), then press Enter.
      const buffer = `morndo-${randomUUID()}`;
      call?.signal?.throwIfAborted();             // the deadline's last word: nothing is pasted after it
      await new Promise<void>((resolve, reject) => {
        // The same 5 s bound as every other tmux call here; SIGKILL, because tmux's client exits 0 on SIGTERM, which would read as success.
        const p = spawn("tmux", tmuxArgv(opts.socket, ["load-buffer", "-b", buffer, "-", ";", "paste-buffer", "-p", "-d", "-b", buffer, "-t", id, ";", "send-keys", "-t", id, "Enter"]), { timeout: 5000, killSignal: "SIGKILL" });
        p.on("error", reject);
        p.on("exit", (code, signal) => (code === 0 ? resolve() : reject(new Error(`tmux exited ${code ?? signal}`))));
        p.stdin.on("error", () => { /* the exit handler reports it */ });
        p.stdin.end(clean);
      });
      await new Promise(r => setTimeout(r, 400));
      const after = await styled(id);
      const draft = after ? draftOnScreen(after) : null;
      return draft && clean.startsWith(draft.slice(0, 20)) ? "not_submitted" : null;
    },
    async capture(id) {
      if (!/^%\d+$/.test(id)) return null;
      try {
        const out = await tmux(["capture-pane", "-p", "-J", "-t", id, "-S", `-${history}`]);
        return out.split("\n").map(l => l.trimEnd()).join("\n").replace(/\n+$/, "");
      } catch {
        return null;                                      // the pane went away between list and capture
      }
    },
  };
}
