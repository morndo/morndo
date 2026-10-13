// The protocol-1 fixture (design §5, §13): fixed answers, chosen by the input's basename. No audio is read.
// A hang input starts a child and stays up, so a host that kills only the parent leaves the child, and a host
// that kills the process group takes both.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseProbe, parseRun } from "../src/index.ts";
import { SENTENCE } from "./answers.mjs";
import { alive, until } from "./proc.ts";

const linuxOnly = it.runIf(process.platform === "linux");

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-transcribe.mjs", import.meta.url));
const PROBE = {
  protocol: 1, ready: true, engine: "fixture-ear", engineVersion: "1.0.0", model: "tiny-fixture",
  languages: "multi", maxSeconds: 600, missing: [],
};

const runArgs = (input: string, language = "auto"): string[] =>
  ["run", "--input", input, "--language", language, "--threads", "2", "--max-seconds", "600", "--json"];

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

function childrenOf(pid: number): number[] {
  try {
    const raw = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
    return raw === "" ? [] : raw.split(/\s+/).map(Number);
  } catch {
    return [];
  }
}

describe("fake-transcribe", () => {
  it("probes ready and returns the fixed sentence for a run", async () => {
    const probe = await run(["probe", "--json"]);
    expect(probe.code).toBe(0);
    expect(probe.stderr).toBe("");
    expect(probe.stdout).toBe(JSON.stringify(PROBE));
    expect(parseProbe(probe.stdout)).toEqual({ ok: true, value: PROBE });

    const heard = await run(runArgs("/audio/note.wav"));
    expect(heard.code).toBe(0);
    expect(heard.stderr).toBe("");
    expect(JSON.parse(heard.stdout)).toEqual({
      protocol: 1, language: "de", durationMs: 5200,
      segments: [{ startMs: 0, endMs: 5200, text: SENTENCE }],
    });
    const english = await run(runArgs("/audio/note.wav", "en"));
    expect(english.code).toBe(0);
    expect(JSON.parse(english.stdout)).toEqual({
      protocol: 1, language: "en", durationMs: 5200,
      segments: [{ startMs: 0, endMs: 5200, text: SENTENCE }],
    });
    const ordered = await run(["run", "--language", "pt-BR", "--max-seconds", "30", "--json", "--threads", "1", "--input", "/audio/note.wav"]);
    expect(JSON.parse(ordered.stdout).language).toBe("pt-BR");
  });

  it("exits 2 on a bad invocation, and 3, 4 or 5 for the named files, with no sentence", async () => {
    expect((await run(["probe"])).code).toBe(2);
    expect((await run(["run", "--json"])).code).toBe(2);
    expect((await run(runArgs("note.wav"))).code).toBe(2);
    expect((await run(runArgs("/audio/note.wav", "DE"))).code).toBe(2);
    expect((await run(["run", "--input", "/audio/note.wav", "--language", "auto", "--threads", "0", "--max-seconds", "600", "--json"])).code).toBe(2);
    expect((await run(["nope", "--json"])).code).toBe(2);

    const unread = await run(runArgs("/audio/unreadable.bin"));
    expect(unread.code).toBe(3);
    expect(unread.stdout).not.toContain(SENTENCE);
    expect((await run(runArgs("/audio/too-long.wav"))).code).toBe(4);
    expect((await run(runArgs("/audio/not-ready.wav"))).code).toBe(5);
  });

  it("prints a document the schema refuses, or a token on stderr beside a valid run", async () => {
    const bad = await run(runArgs("/audio/bad-json.wav"));
    expect(bad.code).toBe(0);
    expect(parseRun(bad.stdout)).toEqual({ ok: false, error: "bad_output" });
    const other = await run(runArgs("/audio/protocol-2.wav"));
    expect(other.code).toBe(0);
    expect(parseRun(other.stdout)).toEqual({ ok: false, error: "bad_output" });
    expect(other.stdout).toContain('"protocol":2');
    const huge = await run(runArgs("/audio/huge.wav"));
    expect(huge.code).toBe(0);
    expect(huge.stdout.length).toBeGreaterThan(1024 * 1024);
    expect(parseRun(huge.stdout)).toEqual({ ok: false, error: "bad_output" });
    const token = await run(runArgs("/audio/stderr-token.wav"));
    expect(token.code).toBe(0);
    expect(parseRun(token.stdout)).toEqual({
      ok: true,
      value: { protocol: 1, language: "de", durationMs: 5200, segments: [{ startMs: 0, endMs: 5200, text: SENTENCE }] },
    });
    expect(token.stderr).toBe("fixture-token-9f3a\n");
  });

  linuxOnly("a hang stays up with a child, a signal to the parent leaves the child, and the group kill takes both", async () => {
    const proc = spawn(process.execPath, [FIXTURE, ...runArgs("/audio/hang.wav")], { detached: true, stdio: "ignore" });
    const pid = proc.pid;
    if (pid === undefined) throw new Error("the fixture started without a pid");
    let kids: number[] = [];
    try {
      expect(await until(() => childrenOf(pid).length === 1, 2000)).toBe(true);
      kids = childrenOf(pid);
      expect(kids).toHaveLength(1);
      process.kill(pid, "SIGTERM");
      expect(await until(() => !alive(pid), 2000)).toBe(true);
      expect(kids.every(child => alive(child))).toBe(true);
      process.kill(-pid, "SIGKILL");
      expect(await until(() => kids.every(child => !alive(child)), 2000)).toBe(true);
    } finally {
      try { process.kill(-pid, "SIGKILL"); } catch { /* the group is already gone */ }
      for (const child of kids) {
        try { process.kill(child, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  });
});
