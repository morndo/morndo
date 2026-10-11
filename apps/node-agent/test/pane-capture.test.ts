// pane.capture (fleet clients spec §5, "Reading"): a pane's last lines, at most 2000, with tmux's attribute escapes when
// asked, in one answer of at most 256 KiB (LIMITS.captureMaxBytes, one bulk chunk); pane.captureMany keeps its 6 KiB a
// pane. Real isolated tmux, with panes that print known screens.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMITS } from "@morndo/protocol";
import { isolatedTmux, tempHome, until, type TestTmux } from "./helpers.ts";
import { opsHarness, type Harness } from "./ops-harness.ts";

let home: { home: string; cleanup: () => void };
let t: TestTmux;
let h: Harness;
beforeEach(() => {
  home = tempHome();
  t = isolatedTmux();
  h = opsHarness({ home: home.home, socket: t.socket });
  t.tmux("new-session", "-d", "-s", "main", "-n", "base", "-x", "250", "-y", "50", "sleep 600");
  t.tmux("set-option", "-g", "history-limit", "5000");             // the windows made after this keep 2000 lines and more
});
afterEach(async () => { h.close(); await t.kill(); home.cleanup(); });

// A lane whose pane runs `script` with sh, then stays.
async function lane(name: string, script: string): Promise<string> {
  const file = join(home.home, `${name}.sh`);
  writeFileSync(file, `${script}\nexec sleep 600\n`);
  t.tmux("new-window", "-d", "-t", "=main:", "-n", name, `sh ${file}`);
  const p = (await h.inventory.refresh()).panes.find(x => x.window === name);
  if (!p) throw new Error(`no lane ${name}`);
  return p.workerId;
}
async function capture(workerId: string, lines: number, attributes?: boolean) {
  const r = await h.call("pane.capture", { workerId, lines, ...(attributes !== undefined ? { attributes } : {}) });
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.result as { text: string | null; truncated: boolean };
}

describe("pane.capture (spec §5)", () => {
  it("returns a pane's last lines, plain or with the screen's attribute escapes, and refuses more than 2000 lines", async () => {
    const w = await lane("dim", "printf 'one\\ntwo\\n\\033[2mdim words\\033[0m\\n'");
    expect(await until(async () => (await capture(w, 50)).text?.includes("dim words") ?? false)).toBe(true);
    const plain = await capture(w, 50);
    expect(plain.truncated).toBe(false);
    expect(plain.text).toContain("one\ntwo\ndim words");
    expect(plain.text).not.toContain("\u001b[");
    expect((await capture(w, 50, true)).text).toContain("\u001b[2m");
    expect(await h.call("pane.capture", { workerId: w, lines: 2000 })).toMatchObject({ ok: true });
    for (const lines of [0, 2001]) {
      expect(await h.call("pane.capture", { workerId: w, lines }), String(lines)).toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });
    }
  });

  it("joins a line the pane wrapped, unless asked not to (join: false; RECONCILIATION.md ruling 10)", async () => {
    const w = await lane("wrapped", `printf '%s\\n' '${"y".repeat(300)}'`);
    expect(await until(async () => (await capture(w, 10)).text?.includes("y".repeat(300)) ?? false)).toBe(true);
    const r = await h.call("pane.capture", { workerId: w, lines: 10, join: false });
    if (!r.ok) throw new Error(r.error.message);
    const text = (r.result as { text: string }).text;
    expect(text).toContain("y".repeat(250));                          // the pane is 250 columns wide
    expect(text).not.toContain("y".repeat(251));
  });

  it("keeps its answer within 256 KiB, the bottom of the pane kept and truncated said, while pane.captureMany keeps 6 KiB a pane", async () => {
    const line = (i: number) => `${String(i).padStart(4, "0")} ${"x".repeat(195)}`;
    const file = join(home.home, "screen.txt");
    writeFileSync(file, `${Array.from({ length: 2000 }, (_, i) => line(i)).join("\n")}\n`);
    const w = await lane("big", `cat '${file}'`);
    expect(await until(async () => (await capture(w, 5)).text?.includes(line(1999)) ?? false, 10_000)).toBe(true);
    const r = await h.call("pane.capture", { workerId: w, lines: 2000 });
    if (!r.ok) throw new Error(r.error.message);
    const got = r.result as { text: string; truncated: boolean };
    expect(got.truncated).toBe(true);
    const bytes = Buffer.byteLength(JSON.stringify(got.text));
    expect(bytes).toBeLessThanOrEqual(LIMITS.captureMaxBytes);
    expect(bytes).toBeGreaterThan(LIMITS.captureMaxBytes - 1024);   // the cap is used, not a smaller one
    expect(got.text.trimEnd().endsWith(line(1999))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify({ v: 1, t: "res", ...r }))).toBeLessThanOrEqual(LIMITS.maxMessageBytes);
    const many = await h.call("pane.captureMany", { workerIds: [w] });
    const one = many.ok ? (many.result as { captures: { text: string | null }[] }).captures[0]?.text ?? "" : "";
    expect(Buffer.byteLength(JSON.stringify(one))).toBeLessThanOrEqual(LIMITS.captureBytesPerPane);
  }, 30_000);

  it("answers text null for a worker id that is no lane here", async () => {
    expect(await capture("pc.0a1b2c3d.999", 10)).toEqual({ text: null, truncated: false });
  });
});
