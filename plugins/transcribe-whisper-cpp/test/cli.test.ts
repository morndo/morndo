// The executable, with a stand-in whisper-cli. ffmpeg is the system's. A machine without ffmpeg skips these
// and says so; the plugin workflow installs it.
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { parseProbe, parseRun } from "@morndo/protocol";
import { commandOnPath } from "../src/morndo-transcribe.mts";
import { pcmWav } from "./audio.ts";

const ffmpeg = commandOnPath("ffmpeg", process.env.PATH ?? "");
const SRC = join(import.meta.dirname, "../src");
const ROOT = mkdtempSync(join(tmpdir(), "morndo-transcribe-cli-"));
const BIN = join(ROOT, "bin");

function stage(withModel: boolean): void {
  mkdirSync(BIN, { recursive: true });
  mkdirSync(join(ROOT, "models"), { recursive: true });
  copyFileSync(join(SRC, "morndo-transcribe.cjs"), join(BIN, "morndo-transcribe"));
  chmodSync(join(BIN, "morndo-transcribe"), 0o755);
  copyFileSync(join(SRC, "morndo-transcribe.mts"), join(BIN, "morndo-transcribe.mts"));
  writeFileSync(join(BIN, "whisper-cli"), `#!/bin/sh
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-of" ]; then
    out="$2"
    shift 2
    continue
  fi
  shift
done
cat > "$out.json" <<'EOF'
{"result":{"language":"de"},"transcription":[{"offsets":{"from":0,"to":800},"text":" Hafen frei."}]}
EOF
`);
  chmodSync(join(BIN, "whisper-cli"), 0o755);
  writeFileSync(join(ROOT, "plugin.json"), JSON.stringify({
    name: "transcribe", version: "0.0.0", protocol: 1, engine: "whisper.cpp", engineVersion: "1.9.5",
    model: "base", modelFile: "ggml-base.bin", languages: "multi", maxSeconds: 600,
  }));
  const model = join(ROOT, "models", "ggml-base.bin");
  if (withModel) writeFileSync(model, "not-weights");
  else rmSync(model, { force: true });
}

function run(args: string[], pathEnv: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(BIN, "morndo-transcribe"), ...args], {
      env: { PATH: pathEnv, HOME: "/tmp", LANG: "C", TMPDIR: tmpdir() },
      stdio: ["ignore", "pipe", "pipe"],
    });
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

const pathEnv = ffmpeg === null ? "/bin" : `${dirname(ffmpeg)}:/bin`;
const live = it.runIf(ffmpeg !== null);

afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

describe("morndo-transcribe", () => {
  live("probes ready when the model, whisper-cli and ffmpeg are there", async () => {
    stage(true);
    const probe = await run(["probe", "--json"], pathEnv);
    expect(probe.code).toBe(0);
    expect(probe.stderr).toBe("");
    const body = {
      protocol: 1, ready: true, engine: "whisper.cpp", engineVersion: "1.9.5", model: "base",
      languages: "multi", maxSeconds: 600, missing: [],
    };
    expect(probe.stdout).toBe(JSON.stringify(body));
    expect(parseProbe(probe.stdout)).toEqual({ ok: true, value: body });
  });

  live("names a missing model, and a missing ffmpeg, and still speaks protocol 1", async () => {
    stage(false);
    const noModel = await run(["probe", "--json"], pathEnv);
    expect(noModel.code).toBe(0);
    expect(JSON.parse(noModel.stdout)).toEqual({ protocol: 1, ready: false, missing: ["model"] });
    stage(true);
    const empty = join(ROOT, "empty-path");
    mkdirSync(empty);
    const noFfmpeg = await run(["probe", "--json"], empty);
    expect(JSON.parse(noFfmpeg.stdout)).toEqual({ protocol: 1, ready: false, missing: ["ffmpeg"] });
  });

  live("exits 2 on a bad invocation", async () => {
    stage(true);
    expect((await run(["probe"], pathEnv)).code).toBe(2);
    expect((await run(["run", "--json"], pathEnv)).code).toBe(2);
    expect((await run(["run", "--input", "note.wav", "--language", "auto", "--threads", "1", "--max-seconds", "600", "--json"], pathEnv)).code).toBe(2);
    expect((await run(["nope", "--json"], pathEnv)).code).toBe(2);
  });

  live("maps a run to protocol 1, and exits 3, 4 or 5 without a transcript", async () => {
    stage(true);
    const note = join(ROOT, "note.wav");
    writeFileSync(note, pcmWav(1));
    const heard = await run(["run", "--input", note, "--language", "auto", "--threads", "1", "--max-seconds", "600", "--json"], pathEnv);
    expect(heard.code).toBe(0);
    expect(heard.stderr).toBe("");
    const body = {
      protocol: 1, language: "de", durationMs: 1000,
      segments: [{ startMs: 0, endMs: 800, text: "Hafen frei." }],
    };
    expect(JSON.parse(heard.stdout)).toEqual(body);
    expect(parseRun(heard.stdout)).toEqual({ ok: true, value: body });

    const junk = join(ROOT, "unreadable.bin");
    writeFileSync(junk, "this is not audio\n");
    const unread = await run(["run", "--input", junk, "--language", "auto", "--threads", "1", "--max-seconds", "600", "--json"], pathEnv);
    expect(unread.code).toBe(3);
    expect(unread.stdout).toBe("");

    const long = join(ROOT, "long.wav");
    writeFileSync(long, pcmWav(1.5));
    const tooLong = await run(["run", "--input", long, "--language", "auto", "--threads", "1", "--max-seconds", "1", "--json"], pathEnv);
    expect(tooLong.code).toBe(4);
    expect(tooLong.stdout).toBe("");

    stage(false);
    const notReady = await run(["run", "--input", note, "--language", "auto", "--threads", "1", "--max-seconds", "600", "--json"], pathEnv);
    expect(notReady.code).toBe(5);
    expect(notReady.stdout).toBe("");
    expect(notReady.stderr).toContain("model");
  });
});

it.runIf(ffmpeg === null)("the CLI runs need ffmpeg, which this machine does not have on PATH", () => {
  expect(ffmpeg).toBeNull();
});
