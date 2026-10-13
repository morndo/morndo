import { describe, expect, it } from "vitest";
import { hostTmuxServer, tmuxHostCommand } from "../src/tmux-host.ts";

describe("tmux host", () => {
  it("starts the server in a user scope, outside the caller's unit", () => {
    expect(tmuxHostCommand("sock", true)).toEqual({
      command: "systemd-run",
      args: ["--user", "--scope", "--quiet", "--collect", "tmux", "-u", "-L", "sock", "start-server", ";", "set-option", "-s", "exit-empty", "off"],
    });
  });
  it("starts tmux in this process when there is no user manager", () => {
    expect(tmuxHostCommand(null, false)).toEqual({
      command: "tmux",
      args: ["-u", "start-server", ";", "set-option", "-s", "exit-empty", "off"],
    });
  });
  it("starts tmux in this process when the user manager does not answer", async () => {
    const ran: { command: string }[] = [];
    const how = await hostTmuxServer({
      socket: null,
      env: { XDG_RUNTIME_DIR: "/run/user/1" },
      usable: async () => false,
      exec: async command => { ran.push({ command }); },
    });
    expect(how).toBe("in-unit");
    expect(ran).toEqual([{ command: "tmux" }]);
  });
  it("does not call systemd-run from a test", async () => {
    let called = false;
    const how = await hostTmuxServer({
      socket: "sock",
      env: { NODE_ENV: "test", XDG_RUNTIME_DIR: "/run/user/1" },
      exec: async () => { called = true; },
    });
    expect(how).toBe("skipped");
    expect(called).toBe(false);
  });
  it("starts the server with systemd-run --user --scope and turns exit-empty off", async () => {
    const ran: { command: string; args: string[] }[] = [];
    const exec = async (command: string, args: string[]) => { ran.push({ command, args }); };
    const how = await hostTmuxServer({
      socket: "sock",
      env: { XDG_RUNTIME_DIR: "/run/user/1" },
      usable: async () => true,
      exec,
    });
    expect(how).toBe("scoped");
    expect(ran).toEqual([{
      command: "systemd-run",
      args: ["--user", "--scope", "--quiet", "--collect", "tmux", "-u", "-L", "sock", "start-server", ";", "set-option", "-s", "exit-empty", "off"],
    }]);
  });
  it("stays in this process when MORNDO_TMUX_NO_SCOPE is set, still with exit-empty off", async () => {
    const ran: { command: string; args: string[] }[] = [];
    const how = await hostTmuxServer({
      socket: "sock",
      env: { XDG_RUNTIME_DIR: "/run/user/1", MORNDO_TMUX_NO_SCOPE: "1" },
      usable: async () => true,
      exec: async (command, args) => { ran.push({ command, args }); },
    });
    expect(how).toBe("in-unit");
    expect(ran).toEqual([{
      command: "tmux",
      args: ["-u", "-L", "sock", "start-server", ";", "set-option", "-s", "exit-empty", "off"],
    }]);
  });
});
