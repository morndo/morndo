// How node-ops calls tmux (tmux-cli.ts), on an isolated tmux server: -u keeps names whole without a UTF-8 locale, "=name"
// targets a session exactly, "##" keeps a "#" in a window name or a directory from being read as a format, and the
// shared test helper's kill() waits until the server is gone. Synthetic windows and directories only.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exactSession, tmuxArgv, tmuxFailure, tmuxLiteral } from "../src/tmux-cli.ts";
import { tmuxAdapter } from "../src/tmux.ts";
import { isolatedTmux, type TestTmux } from "./isolated-tmux.ts";

let t: TestTmux;
beforeEach(() => { t = isolatedTmux(); });
afterEach(() => t.kill());

describe("tmuxArgv", () => {
  it("always passes -u, and -L only for a named socket", () => {
    expect(tmuxArgv(null, ["list-sessions"])).toEqual(["-u", "list-sessions"]);
    expect(tmuxArgv("s1", ["list-sessions"])).toEqual(["-u", "-L", "s1", "list-sessions"]);
  });
  it("keeps a window name whole without a UTF-8 locale; tmux without -u mangles it (negative control)", async () => {
    const name = "ünï ✓ fix: a/b";
    t.tmux("new-session", "-d", "-s", "main", "-n", name, "sleep 600");
    // As a service runs: no UTF-8 locale, and not inside tmux (a client inside tmux, with TMUX set, writes UTF-8 anyway).
    const saved = { LC_ALL: process.env.LC_ALL, LC_CTYPE: process.env.LC_CTYPE, LANG: process.env.LANG, TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
    process.env.LC_ALL = "C";
    for (const k of ["LC_CTYPE", "LANG", "TMUX", "TMUX_PANE"]) delete process.env[k];
    try {
      expect((await tmuxAdapter({ socket: t.socket, session: "main" }).listWorkers()).map(w => w.name)).toEqual([name]);
      const raw = execFileSync("tmux", ["-L", t.socket, "list-windows", "-t", "=main", "-F", "#{window_name}"], { encoding: "utf8" }).trim();
      expect(raw).not.toBe(name);
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
});

describe("exactSession", () => {
  it("targets a session by its whole name; a bare name also matches a prefix (negative control)", () => {
    t.tmux("new-session", "-d", "-s", "main", "sleep 600");
    expect(exactSession("main")).toBe("=main");
    expect(() => t.tmux("has-session", "-t", exactSession("main"))).not.toThrow();
    expect(() => execFileSync("tmux", ["-L", t.socket, "has-session", "-t", exactSession("mai")], { stdio: "pipe" })).toThrow();
    expect(() => t.tmux("has-session", "-t", "mai")).not.toThrow();
  });
});

describe("tmuxLiteral", () => {
  it("doubles #, so a window gets exactly the name asked for, made or renamed; unescaped, tmux expands it (negative control)", () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "base", "sleep 600");
    const created = (n: string) => t.tmux("new-window", "-d", "-P", "-F", "#{window_id}", "-t", "=main:", "-n", n, "sleep 600").trim();
    const nameOf = (id: string) => t.tmux("display-message", "-p", "-t", id, "#{window_name}").replace(/\n$/, "");
    for (const name of ["a#S b", "#{pane_id}", "c##d", "fix: a/b ü.2 #1", "review;", ";", "a\\;", "h#S;", "mid;x"]) expect(nameOf(created(tmuxLiteral(name))), name).toBe(name);
    expect(nameOf(created("a#S b"))).toBe("amain b");
    const w = created("plain");
    t.tmux("rename-window", "-t", w, tmuxLiteral("r#{session_name}"));
    expect(nameOf(w)).toBe("r#{session_name}");
    t.tmux("rename-window", "-t", w, "r#{session_name}");
    expect(nameOf(w)).toBe("rmain");
  });
  it("a directory arrives as asked for, and a #(…) in it runs nothing; unescaped, tmux expands it (negative control)", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "morndo-literal-")));
    const odd = [join(dir, "a#{session_name}b"), join(dir, "#(touch m)")];
    for (const d of odd) mkdirSync(d);
    const home = process.env.HOME;
    try {
      process.env.HOME = dir;                                           // the server's HOME: where a #(…) job would run
      t.tmux("new-session", "-d", "-s", "main", "-n", "base", "-c", dir, "sleep 600");
      if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
      const startIn = (cwd: string) => {
        const pane = t.tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "=main:", "-c", cwd, "sleep 600").trim();
        return t.tmux("display-message", "-p", "-t", pane, "#{pane_start_path}").replace(/\n$/, "");
      };
      for (const d of odd) expect(startIn(tmuxLiteral(d)), d).toBe(d);
      expect(startIn(odd[0] ?? "")).toBe(join(dir, "amainb"));
      expect(startIn(odd[1] ?? "")).not.toBe(odd[1]);
      for (let i = 0; i < 10 && !existsSync(join(dir, "m")); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      expect(existsSync(join(dir, "m"))).toBe(false);
    } finally {
      if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("a directory ending in ; arrives as asked for", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "morndo-semi-")));
    try {
      const odd = [join(dir, "d;"), join(dir, "e\\;")];
      for (const d of odd) mkdirSync(d);
      t.tmux("new-session", "-d", "-s", "main", "-n", "base", "-c", dir, "sleep 600");
      for (const d of odd) {
        const pane = t.tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "=main:", "-c", tmuxLiteral(d), "sleep 600").trim();
        expect(t.tmux("display-message", "-p", "-t", pane, "#{pane_start_path}").replace(/\n$/, ""), d).toBe(d);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("isolatedTmux (the shared test helper)", () => {
  it("kill() returns once the server is gone, so a new one starts at once on the same socket, and leaves no socket file", async () => {
    const file = join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`, t.socket);
    for (let i = 0; i < 5; i++) {
      t.tmux("new-session", "-d", "-s", "main", "sleep 600");
      const pid = Number(t.tmux("display-message", "-p", "-t", "=main", "#{pid}").trim());
      expect(existsSync(file)).toBe(true);
      await t.kill();
      expect(() => process.kill(pid, 0), `server ${pid}`).toThrow();    // the server process itself has exited
      expect(() => execFileSync("tmux", ["-L", t.socket, "list-sessions"], { stdio: "pipe" })).toThrow();
      expect(existsSync(file)).toBe(false);
    }
  });
});

describe("tmuxFailure", () => {
  const exit = (code: number | null, stderr: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error("tmux failed"), { code, killed: false, signal: null, stderr, ...extra });
  it("is absent only for exit 1 with tmux's own words for no server, no session, no pane", () => {
    for (const stderr of ["can't find window: main\n", "can't find session: main\n", "can't find pane: %9\n",
      "no server running on /tmp/tmux-501/x\n", "error connecting to /tmp/tmux-501/x (No such file or directory)\n",
      "error connecting to /tmp/tmux-501/x (Connection refused)\n"]) {
      expect(tmuxFailure(exit(1, stderr)), stderr).toBe("absent");
    }
  });
  it("is unavailable for a timeout kill, a spawn error, another exit code or other words (negative controls)", () => {
    expect(tmuxFailure(exit(null, "", { killed: true, signal: "SIGKILL" }))).toBe("unavailable");
    expect(tmuxFailure(Object.assign(new Error("spawn tmux EMFILE"), { code: "EMFILE" }))).toBe("unavailable");
    expect(tmuxFailure(exit(2, "can't find session: main\n"))).toBe("unavailable");
    expect(tmuxFailure(exit(1, "server exited unexpectedly\n"))).toBe("unavailable");
    expect(tmuxFailure(exit(1, "can't find window: main\n", { killed: true }))).toBe("unavailable");
    expect(tmuxFailure("not an error")).toBe("unavailable");
  });
});
