import { execFile, spawn, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { promisify } from "node:util";
import { exactSession, tmuxArgv, tmuxFailure, tmuxLiteral } from "@morndo/node-ops";
import { signInBufferName } from "./buffer-name.ts";

type ExecResult = { stdout: string; stderr: string };
type ExecFn = (file: string, args: readonly string[], opts?: ExecFileOptionsWithStringEncoding) => Promise<ExecResult>;

const defaultRun: ExecFn = promisify(execFile);

function execWithInput(file: string, args: readonly string[], input: string, spawnFn: typeof spawn): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawnFn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const err = new Error(`${file} exited ${code ?? signal}`) as Error & { code?: number | null; stderr?: string; signal?: NodeJS.Signals | null; killed?: boolean };
        err.code = code;
        err.stderr = stderr;
        err.signal = signal;
        err.killed = false;
        reject(err);
      }
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

export type SignInTerminal = {
  open(id: string, command: readonly string[]): Promise<void>;
  screen(id: string): Promise<string>;
  exit(id: string): Promise<{ dead: boolean; status: number | null }>;
  type(id: string, text: string): Promise<void>;
  enter(id: string): Promise<void>;
  close(id: string): Promise<void>;
};

export function tmuxTerminal(socket: string, run: ExecFn = defaultRun, spawnFn: typeof spawn = spawn): SignInTerminal {
  const tmux = (args: readonly string[], opts?: ExecFileOptionsWithStringEncoding) =>
    run("tmux", tmuxArgv(socket, args), { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, ...opts });
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
      } catch (e) {
        if (tmuxFailure(e) === "absent") return { dead: true, status: null };
        throw e;
      }
    },
    async type(id, text) {
      const buf = signInBufferName(id);
      await execWithInput("tmux", tmuxArgv(socket, ["load-buffer", "-b", buf, "-"]), text, spawnFn);
      await tmux(["paste-buffer", "-d", "-b", buf, "-t", pane(id)]);
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
