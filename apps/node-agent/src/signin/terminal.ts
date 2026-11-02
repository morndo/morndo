import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { exactSession, tmuxArgv, tmuxLiteral } from "@morndo/node-ops";

const run = promisify(execFile);

// send-keys -l does not expand formats; only a trailing ";" ends the tmux command (tmux-cli.ts rule for "\;").
const sendKeysLiteral = (text: string): string =>
  text.endsWith(";") ? `${text.slice(0, -1)}\\;` : text;

export type SignInTerminal = {
  open(id: string, command: readonly string[]): Promise<void>;
  screen(id: string): Promise<string>;
  exit(id: string): Promise<{ dead: boolean; status: number | null }>;
  type(id: string, text: string): Promise<void>;
  enter(id: string): Promise<void>;
  close(id: string): Promise<void>;
};

export function tmuxTerminal(socket: string): SignInTerminal {
  const tmux = (args: readonly string[]) => run("tmux", tmuxArgv(socket, args), { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const session = (id: string) => exactSession(id);
  const pane = (id: string) => `${exactSession(id)}:`;

  return {
    async open(id, command) {
      await tmux([
        "new-session", "-d", "-s", tmuxLiteral(id), "-x", "250", "-y", "50",
        ...command,
        ";", "set-option", "-t", tmuxLiteral(id), "remain-on-exit", "on",
      ]);
    },
    async screen(id) {
      const { stdout } = await tmux(["capture-pane", "-p", "-J", "-S", "-200", "-t", pane(id)]);
      return stdout;
    },
    async exit(id) {
      try {
        const { stdout } = await tmux(["display-message", "-p", "-t", pane(id), "#{pane_dead} #{pane_dead_status}"]);
        const [deadRaw, statusRaw] = stdout.trim().split(/\s+/);
        return { dead: deadRaw === "1", status: deadRaw === "1" ? Number(statusRaw) : null };
      } catch {
        return { dead: true, status: null };
      }
    },
    async type(id, text) {
      await tmux(["send-keys", "-t", pane(id), "-l", "--", sendKeysLiteral(text)]);
    },
    async enter(id) {
      await tmux(["send-keys", "-t", pane(id), "Enter"]);
    },
    async close(id) {
      try { await tmux(["clear-history", "-t", pane(id)]); } catch { /* session may be gone */ }
      try { await tmux(["kill-session", "-t", session(id)]); } catch { /* already closed */ }
    },
  };
}
