import { execFileSync, spawn as spawnReal } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { tmuxTerminal } from "../src/signin/terminal.ts";

const SOCKET = `signin-argv-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const defaultRun = promisify(execFile);

afterAll(() => {
  try { execFileSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" }); } catch { /* none */ }
});

describe("tmuxTerminal.type argv", () => {
  it("never passes the paste code as a tmux command-line argument", async () => {
    const code = "plain#code";
    const loadArgv: string[][] = [];
    const spawnFn = ((file: string, args?: readonly string[], opts?: Parameters<typeof spawnReal>[2]) => {
      if (file === "tmux" && args?.includes("load-buffer")) loadArgv.push([...(args as string[])]);
      return spawnReal(file, args as string[], opts ?? {});
    }) as unknown as typeof spawnReal;
    const terminal = tmuxTerminal(SOCKET, defaultRun, spawnFn);
    const id = `argv-${Math.random().toString(36).slice(2, 8)}`;
    await terminal.open(id, ["cat"]);
    await terminal.type(id, code);
    expect(loadArgv.length).toBeGreaterThan(0);
    for (const args of loadArgv) expect(args.join("\0")).not.toContain(code);
    await terminal.close(id);
  });
});
