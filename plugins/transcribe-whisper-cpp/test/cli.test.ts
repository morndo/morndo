// The executable, with a stand-in whisper-cli. ffmpeg is the system's. A machine without ffmpeg skips these
// and says so; the plugin workflow installs it.
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { parseProbe, parseRun } from "@morndo/protocol";
import { commandOnPath } from "../src/morndo-transcribe.mts";
import { contractSubject } from "./host.ts";
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

  live("stops a long input at the cap and reports too_long from the wav header", async () => {
    stage(true);
    const seen = join(ROOT, "ffmpeg-args");
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + 16_000 * 2 * 601, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16_000, 24);
    header.writeUInt32LE(16_000 * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(16_000 * 2 * 601, 40);
    const declared = join(ROOT, "declared.wav");
    writeFileSync(declared, header);
    writeFileSync(join(BIN, "ffmpeg"), `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(seen)}
out=""
for arg in "$@"; do out="$arg"; done
cp ${JSON.stringify(declared)} "$out"
`);
    chmodSync(join(BIN, "ffmpeg"), 0o755);
    const note = join(ROOT, "long-input.wav");
    writeFileSync(note, pcmWav(1));
    const tooLong = await run(
      ["run", "--input", note, "--language", "en", "--threads", "1", "--max-seconds", "600", "--json"],
      `${BIN}:${pathEnv}`,
    );
    const args = readFileSync(seen, "utf8").split("\n").filter(line => line !== "");
    expect(args[args.indexOf("-t") + 1]).toBe("601");
    expect(args.indexOf("-t")).toBeLessThan(args.indexOf("-i"));
    expect(tooLong.code).toBe(4);
    expect(tooLong.stdout).toBe("");
  });

  live("passes whisper the primary language of a region tag", async () => {
    stage(true);
    const seen = join(ROOT, "seen-lang");
    writeFileSync(join(BIN, "whisper-cli"), `#!/bin/sh
lang=""
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-l" ]; then lang="$2"; shift 2; continue; fi
  if [ "$1" = "-of" ]; then out="$2"; shift 2; continue; fi
  shift
done
printf '%s' "$lang" > ${JSON.stringify(seen)}
if [ "$lang" != "pt" ]; then exit 0; fi
cat > "$out.json" <<'EOF'
{"result":{"language":"pt"},"transcription":[{"offsets":{"from":0,"to":400},"text":" porto"}]}
EOF
`);
    chmodSync(join(BIN, "whisper-cli"), 0o755);
    const note = join(ROOT, "pt.wav");
    writeFileSync(note, pcmWav(1));
    const heard = await run(["run", "--input", note, "--language", "pt-BR", "--threads", "1", "--max-seconds", "600", "--json"], pathEnv);
    expect(readFileSync(seen, "utf8")).toBe("pt");
    expect(heard.code).toBe(0);
    expect(JSON.parse(heard.stdout)).toEqual({
      protocol: 1, language: "pt", durationMs: 1000,
      segments: [{ startMs: 0, endMs: 400, text: "porto" }],
    });
  });

  live("whisper's own stderr is not the transcript", async () => {
    stage(true);
    writeFileSync(join(BIN, "whisper-cli"), `#!/bin/sh
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-of" ]; then out="$2"; shift 2; continue; fi
  shift
done
echo "engine chatter" >&2
cat > "$out.json" <<'EOF'
{"result":{"language":"de"},"transcription":[{"offsets":{"from":0,"to":800},"text":" Hafen frei."}]}
EOF
`);
    chmodSync(join(BIN, "whisper-cli"), 0o755);
    const note = join(ROOT, "stderr.wav");
    writeFileSync(note, pcmWav(1));
    const heard = await run(["run", "--input", note, "--language", "de", "--threads", "1", "--max-seconds", "600", "--json"], pathEnv);
    expect(heard.code).toBe(0);
    expect(heard.stderr).toBe("");
    expect(JSON.parse(heard.stdout).language).toBe("de");
  });

  live("whisper exiting 0 without a transcript is an engine error", async () => {
    stage(true);
    writeFileSync(join(BIN, "whisper-cli"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(BIN, "whisper-cli"), 0o755);
    const note = join(ROOT, "silent.wav");
    writeFileSync(note, pcmWav(1));
    const missing = await run(["run", "--input", note, "--language", "en", "--threads", "1", "--max-seconds", "600", "--json"], pathEnv);
    expect(missing.code).toBe(1);
    expect(missing.stdout).toBe("");
  });

  live("a symlink to morndo-transcribe still probes", async () => {
    stage(true);
    const linkDir = join(ROOT, "links");
    mkdirSync(linkDir);
    const link = join(linkDir, "morndo-transcribe");
    symlinkSync(join(BIN, "morndo-transcribe"), link);
    const probe = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [link, "probe", "--json"], {
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
    expect(probe.code).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual({
      protocol: 1, ready: true, engine: "whisper.cpp", engineVersion: "1.9.5", model: "base",
      languages: "multi", maxSeconds: 600, missing: [],
    });
  });

  live("SIGTERM removes the converted clip before the process exits", async () => {
    await expectStopped("SIGTERM");
  });

  live("SIGINT removes the converted clip before the process exits", async () => {
    await expectStopped("SIGINT");
  });

  live("an abort leaves the host's temp dir empty", async () => {
    stage(true);
    writeFileSync(join(BIN, "whisper-cli"), "#!/bin/sh\nsleep 30\n");
    chmodSync(join(BIN, "whisper-cli"), 0o755);
    const note = join(ROOT, "abort.wav");
    writeFileSync(note, pcmWav(1));
    const watch = mkdtempSync(join(tmpdir(), "morndo-abort-"));
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = watch;
    const ac = new AbortController();
    const subject = contractSubject(join(BIN, "morndo-transcribe"), join(BIN, "morndo-transcribe"), join(ROOT, "unused.wav"));
    const pending = subject.transcriber.transcribe({
      path: note, language: "auto", threads: 1, maxSeconds: 600, signal: ac.signal,
    });
    try {
      expect(await until(() => hasClip(watch), 5000)).toBe(true);
      ac.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(readdirSync(watch)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      rmSync(watch, { recursive: true, force: true });
      for (const pid of subject.group?.() ?? []) {
        try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  });
});

function hasClip(dir: string): boolean {
  try {
    return readdirSync(dir, { recursive: true }).some(name => String(name).endsWith("in.wav"));
  } catch {
    return false;
  }
}

function until(ready: () => boolean, ms: number): Promise<boolean> {
  const start = Date.now();
  return new Promise(resolve => {
    const tick = () => {
      if (ready()) resolve(true);
      else if (Date.now() - start > ms) resolve(false);
      else setTimeout(tick, 20);
    };
    tick();
  });
}

async function expectStopped(signal: NodeJS.Signals): Promise<void> {
  stage(true);
  writeFileSync(join(BIN, "whisper-cli"), "#!/bin/sh\nsleep 30\n");
  chmodSync(join(BIN, "whisper-cli"), 0o755);
  const watch = mkdtempSync(join(tmpdir(), "morndo-stop-"));
  const note = join(ROOT, `stop-${signal}.wav`);
  writeFileSync(note, pcmWav(1));
  const child: ChildProcess = spawn(process.execPath, [
    join(BIN, "morndo-transcribe"), "run",
    "--input", note, "--language", "auto", "--threads", "1", "--max-seconds", "600", "--json",
  ], {
    detached: true,
    env: { PATH: pathEnv, HOME: "/tmp", LANG: "C", TMPDIR: watch },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.resume();
  child.stderr?.resume();
  try {
    expect(await until(() => hasClip(watch), 5000)).toBe(true);
    if (child.pid !== undefined) process.kill(-child.pid, signal);
    const code = await new Promise<number | null>(resolve => child.on("close", resolve));
    expect(code).toBe(signal === "SIGINT" ? 130 : 143);
    expect(readdirSync(watch)).toEqual([]);
  } finally {
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }
    rmSync(watch, { recursive: true, force: true });
  }
}

it.runIf(ffmpeg === null)("the CLI runs need ffmpeg, which this machine does not have on PATH", () => {
  expect(ffmpeg).toBeNull();
});
