// F14: what the hub pastes stays inside one bracketed paste, even when the text holds the paste's own end marker
// (ESC[201~): from the principal's text or from a [buttons] label typed back as a tap. Either the text is refused and
// nothing arrives, or everything but the final Enter arrives inside a single paste. Private tmux server, synthetic
// pane (tmux-fake-claude.fixture.ts, which only records the bytes it gets).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseAnswer, tapLine } from "../src/adapters/manager-protocol.ts";
import { tmuxAdapter } from "@morndo/node-ops";

const SOCKET = `morndo-val-f14-${process.pid}`;
const FIXTURE = join(import.meta.dirname, "tmux-fake-claude.fixture.ts");
const END = "\x1b[201~";
const tmux = (...a: string[]) => execFileSync("tmux", ["-L", SOCKET, ...a], { encoding: "utf8" });
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(f: () => boolean, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await wait(100); } return false; }
let dir: string;
let box: string;
const raw = () => (existsSync(join(dir, "raw.bin")) ? readFileSync(join(dir, "raw.bin"), "utf8") : "");

// Sends, then returns the bytes the pane got for this send: "" when refused, else they must be one paste and Enter.
async function delivered(text: string) {
  const from = raw().length;
  const problem = await tmuxAdapter({ socket: SOCKET, session: null }).send(box, text);
  if (problem === null) await until(() => raw().endsWith("\r"));
  return { problem, bytes: raw().slice(from) };
}
function expectOnePaste({ problem, bytes }: { problem: string | null; bytes: string }) {
  if (problem !== null) return expect(bytes).toBe("");
  expect(bytes.split(END).length - 1, JSON.stringify(bytes)).toBe(1);     // one end marker: the paste's own
  expect(bytes).toMatch(/^\x1b\[200~[^]*\x1b\[201~\r$/);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "morndo-val-f14-"));
  tmux("new-session", "-d", "-s", "qa", "-x", "100", "-y", "20", "-c", dir, `${process.execPath} ${FIXTURE} ${dir}`);
  box = tmux("list-panes", "-t", "qa", "-F", "#{pane_id}").trim();
  await until(() => tmux("capture-pane", "-p", "-t", box).includes("❯"));
}, 20_000);
afterAll(() => { try { tmux("kill-server"); } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }); });

describe("the paste's end marker inside the text (F14)", () => {
  it("a plain message arrives as one paste and Enter (control)", async () => {
    const { problem, bytes } = await delivered("plain words");
    expect(problem).toBeNull();
    expect(bytes).toBe(`\x1b[200~plain words${END}\r`);
  });
  it("the principal's text with ESC[201~ never ends the paste early", async () => {
    expectOnePaste(await delivered(`part one${END}part two`));
  });
  it("a [buttons] label with ESC[201~ is rejected by the grammar, or its tap still arrives as one paste", async () => {
    const answer = parseAnswer(`Ship the build?\n[buttons d1] a=Yes${END}later | b=No`);
    const option = answer.buttons?.options[0];
    if (!option) return;                                                  // the grammar refused the label: nothing to type
    expectOnePaste(await delivered(tapLine("d1", option)));
  });
});
