// send-keys -l must deliver sign-in paste codes literally (leading "-", "#", ";" in the text).
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { tmuxTerminal } from "../src/signin/terminal.ts";

const SOCKET = `signin-term-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const terminal = tmuxTerminal(SOCKET);

afterAll(() => {
  try { execFileSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" }); } catch { /* none */ }
});

describe("tmuxTerminal.type", () => {
  it("types each character of a paste code exactly, then Enter", async () => {
    const samples = ["-abc#def_1", "xyz#q;", "a;b", "plain#code"] as const;
    for (const text of samples) {
      const id = `type-${text.replaceAll(/[^a-z0-9]/gi, "x").slice(0, 12)}-${Math.random().toString(36).slice(2, 6)}`;
      await terminal.open(id, ["cat"]);
      await terminal.type(id, text);
      await terminal.enter(id);
      const screen = await terminal.screen(id);
      expect(screen, `screen after typing ${JSON.stringify(text)}`).toContain(text);
      await terminal.close(id);
    }
  });
});
