// morndo-transcribe, plugin protocol 1 (ADR-0021, design §5). The hub spawns the CommonJS shim beside
// this file with an argument vector and never a shell. The model, whisper-cli and plugin.json live in
// the install directory (design §7). Audio is converted with the system's ffmpeg to 16 kHz mono WAV, then
// whisper-cli writes its JSON, which this maps to one protocol document on stdout. Nothing here uses the
// network. whisper.cpp's -oj offsets are milliseconds: examples/cli/cli.cpp writes t0 * 10, and t0 is
// whisper's 10 ms unit (v1.9.5, read 2026-10-13).
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const EXIT = { usage: 2, unreadable: 3, tooLong: 4, notReady: 5, engine: 1 } as const;
// Node's default SIGTERM and SIGINT end the process without running an async `finally`, so the converted
// clip would stay under the temp directory. The handler removes it, then exits.
const scratches = new Set<string>();
// The live children, exported for tests: a listener attached after runChild's own runs behind it in
// the same close dispatch, which is where a stop signal's own handler sits in production.
export const children = new Set<ChildProcess>();

export function sweepScratch(dirs: Set<string>, remove: (dir: string) => void): void {
  for (const dir of [...dirs]) {
    try {
      remove(dir);
      dirs.delete(dir);
    } catch {
      // This dir stays in the set. The next one is still removed.
    }
  }
}

function dropScratch(dir: string): void {
  if (!scratches.has(dir)) return;
  try {
    rmSync(dir, { recursive: true, force: true });
    scratches.delete(dir);
  } catch (error) {
    // The dir stays in the set, as a failed sweep leaves its dir: a stop's sweep retries it. A clip
    // that cannot be removed must not replace the run's own exit code with a crash, but a leaked clip
    // must not be silent either: the hub and the operator get the path and the error code.
    const code = (error as NodeJS.ErrnoException).code ?? String(error);
    process.stderr.write(`scratch dir not removed: ${dir} (${code})\n`);
  }
}

function clearScratch(): void {
  sweepScratch(scratches, (dir) => rmSync(dir, { recursive: true, force: true }));
}

// Set when this process itself was told to stop. The hub's cancel and a Ctrl-C signal the whole
// group, and the engine child can die and report its close before this process's own handler for the
// same signal runs, so how a child died never says why: ffmpeg traps the stop signals and exits 255,
// and a pkill aimed at the engine alone kills it with a SIGTERM this process never got. The flag is
// what a child's close is settled against, never the child's exit report.
let stopSignal: NodeJS.Signals | null = null;

export function setStopSignal(signal: NodeJS.Signals | null): void {
  stopSignal = signal;
}

// runChild settles a close with this when the death turned out to be a stop of the run. The field is
// assigned in the constructor body, not as a parameter property: the file runs on Node's type
// stripping, which carries no transform for those.
export class StoppedRun extends Error {
  readonly signal: NodeJS.Signals;
  constructor(signal: NodeJS.Signals) {
    super(`stopped by ${signal}`);
    this.name = "StoppedRun";
    this.signal = signal;
  }
}

function onStop(signal: NodeJS.Signals): number {
  setStopSignal(signal);
  for (const child of children) {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
  clearScratch();
  return signal === "SIGINT" ? 130 : 143;
}

let stopsBound = false;
function bindStops(): void {
  if (stopsBound) return;
  stopsBound = true;
  process.on("SIGTERM", () => process.exit(onStop("SIGTERM")));
  process.on("SIGINT", () => process.exit(onStop("SIGINT")));
}
const CHOICE = /^(auto|[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*)$/;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
const POSITIVE = /^[1-9]\d*$/;
const ALLOWED = new Set(["--json", "--input", "--language", "--threads", "--max-seconds"]);

export type MappedSegment = { startMs: number; endMs: number; text: string };
export type MappedRun = { protocol: 1; language: string; durationMs: number; segments: MappedSegment[] };
export type ProbeBody =
  | { protocol: 1; ready: true; engine: string; engineVersion: string; model: string; languages: "multi"; maxSeconds: number; missing: [] }
  | { protocol: 1; ready: false; missing: string[] };

type Manifest = {
  engine: string;
  engineVersion: string;
  model: string;
  modelFile: string;
  languages: "multi";
  maxSeconds: number;
};

type FlagBag = { json: boolean; input?: string; language?: string; threads?: string; maxSeconds?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textField(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return null;
  return value;
}

// A region tag is a legal language choice (domain LANGUAGE_CODE, so protocol 1). whisper-cli -l takes the
// language id, so pt-BR becomes pt. Refusing it would be exit 2, which the hub reports as an engine failure.
export function whisperLanguage(choice: string): string {
  if (choice === "auto") return "auto";
  return choice.split("-")[0] ?? choice;
}

export function commandOnPath(name: string, pathEnv: string): string | null {
  for (const dir of pathEnv.split(":")) {
    if (dir === "") continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (st.isFile() && (st.mode & 0o111) !== 0) return full;
    } catch {
      // not this directory
    }
  }
  return null;
}

function executable(path: string): boolean {
  try {
    const st = statSync(path);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function readManifest(root: string): Manifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(root, "plugin.json"), "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const engine = textField(parsed.engine, 64);
  const engineVersion = textField(parsed.engineVersion, 32);
  const model = textField(parsed.model, 128);
  const modelFile = textField(parsed.modelFile, 128);
  if (engine === null || engineVersion === null || model === null || modelFile === null) return null;
  if (modelFile !== basename(modelFile)) return null;
  if (parsed.languages !== "multi") return null;
  if (typeof parsed.maxSeconds !== "number" || !Number.isInteger(parsed.maxSeconds) || parsed.maxSeconds < 1) return null;
  return { engine, engineVersion, model, modelFile, languages: "multi", maxSeconds: parsed.maxSeconds };
}

// Duration of a 16-bit PCM WAV. The data-chunk size is trusted when it fits in the file. The sample
// bytes are not read. ffmpeg writes extra chunks (LIST, fact); those are skipped. A size past the end
// of the file, or the 0xFFFFFFFF placeholder ffmpeg writes when it cannot seek back, is not a length:
// the bytes actually in the file are. If those bytes are not a clip, the caller treats the result as
// an engine failure rather than too_long.
export function wavDurationFile(path: string): number | "engine" | null {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return null; }
  try {
    const size = fstatSync(fd).size;
    const readAt = (at: number, len: number): Buffer | null => {
      if (at < 0 || len < 1 || at + len > size) return null;
      const buf = Buffer.alloc(len);
      return readSync(fd, buf, 0, len, at) === len ? buf : null;
    };
    const head = readAt(0, 12);
    if (head === null || head.toString("latin1", 0, 4) !== "RIFF" || head.toString("latin1", 8, 12) !== "WAVE") return null;
    let offset = 12;
    let rate = 0;
    let channels = 0;
    let bits = 0;
    let dataBytes = -1;
    let fromFile = false;
    const limit = Math.min(size, 1024 * 1024);
    while (offset + 8 <= limit) {
      const hdr = readAt(offset, 8);
      if (hdr === null) return null;
      const id = hdr.toString("latin1", 0, 4);
      const chunk = hdr.readUInt32LE(4);
      const body = offset + 8;
      if (id === "fmt ") {
        if (chunk < 16) return null;
        const fmt = readAt(body, 16);
        if (fmt === null || fmt.readUInt16LE(0) !== 1) return null;
        channels = fmt.readUInt16LE(2);
        rate = fmt.readUInt32LE(4);
        bits = fmt.readUInt16LE(14);
      } else if (id === "data") {
        if (chunk === 0xffffffff || body + chunk > size) {
          dataBytes = size - body;
          fromFile = true;
        } else {
          dataBytes = chunk;
        }
        break;
      }
      offset = body + chunk + (chunk % 2);
    }
    if (rate < 1 || channels < 1 || bits < 8 || bits % 8 !== 0 || dataBytes < 0) return null;
    const block = channels * (bits / 8);
    if (block < 1) return null;
    if (fromFile && (dataBytes < block || dataBytes % block !== 0)) return "engine";
    if (dataBytes % block !== 0) return null;
    return Math.round((dataBytes / block / rate) * 1000);
  } finally {
    closeSync(fd);
  }
}

export function mapWhisper(doc: unknown, wavMs: number): MappedRun | null {
  if (!isRecord(doc) || !Number.isInteger(wavMs) || wavMs < 0) return null;
  if (!isRecord(doc.result) || typeof doc.result.language !== "string" || !LANGUAGE.test(doc.result.language)) return null;
  if (!Array.isArray(doc.transcription)) return null;
  const segments: MappedSegment[] = [];
  let durationMs = wavMs;
  for (const row of doc.transcription) {
    if (!isRecord(row) || !isRecord(row.offsets) || typeof row.text !== "string") return null;
    const startMs = row.offsets.from;
    const endMs = row.offsets.to;
    if (typeof startMs !== "number" || typeof endMs !== "number") return null;
    if (!Number.isInteger(startMs) || !Number.isInteger(endMs) || startMs < 0 || endMs < startMs) return null;
    const text = row.text.trim();
    if (text === "") continue;
    if (endMs > durationMs) durationMs = endMs;
    segments.push({ startMs, endMs, text });
  }
  return { protocol: 1, language: doc.result.language, durationMs, segments };
}

function flags(rest: readonly string[]): FlagBag | null {
  const out: FlagBag = { json: false };
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i];
    if (name === undefined || !name.startsWith("--") || !ALLOWED.has(name)) return null;
    if (name === "--json") {
      out.json = true;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) return null;
    i += 1;
    if (name === "--input") out.input = value;
    else if (name === "--language") out.language = value;
    else if (name === "--threads") out.threads = value;
    else if (name === "--max-seconds") out.maxSeconds = value;
  }
  return out;
}

function missingParts(root: string, pathEnv: string, manifest: Manifest | null): string[] {
  const missing: string[] = [];
  if (commandOnPath("ffmpeg", pathEnv) === null) missing.push("ffmpeg");
  if (!executable(join(root, "bin", "whisper-cli"))) missing.push("whisper-cli");
  if (manifest === null) missing.push("plugin");
  else if (!statFile(join(root, "models", manifest.modelFile))) missing.push("model");
  return missing;
}

function statFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function probeDocument(root: string, pathEnv: string): ProbeBody {
  const manifest = readManifest(root);
  const missing = missingParts(root, pathEnv, manifest);
  if (missing.length > 0 || manifest === null) return { protocol: 1, ready: false, missing: missing.length > 0 ? missing : ["plugin"] };
  return {
    protocol: 1,
    ready: true,
    engine: manifest.engine,
    engineVersion: manifest.engineVersion,
    model: manifest.model,
    languages: "multi",
    maxSeconds: manifest.maxSeconds,
    missing: [],
  };
}

function finish(body: unknown): number {
  process.stdout.write(JSON.stringify(body));
  return 0;
}

function fail(code: number, detail: string): number {
  process.stderr.write(`${detail}\n`);
  return code;
}

type Child = { code: number };

export function runChild(cmd: string, args: string[], cwd: string): Promise<Child> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
    children.add(child);
    child.on("error", reject);
    child.on("close", code => {
      children.delete(child);
      // A stop signal reaches the child and this process at the same time, and this process's own
      // handler for it is itself only an event loop turn: it can sit behind the child's close in the
      // same poll batch, or in the next iteration's poll, because signal events run through the loop
      // like any other (nodejs.org/api/process, signal events, read 2026-10-13). The group's kill
      // marks this process before the child can die, so by the time the close is dispatched the stop
      // event is at most one loop turn away. The close is therefore settled two turns late, each in
      // a check phase behind a poll: any stop this process was sent has then been dispatched and
      // recorded. A death without that record is the engine's own, whatever the child reported, and
      // never a stop nobody sent.
      const settle = (): void => {
        if (stopSignal !== null) {
          reject(new StoppedRun(stopSignal));
          return;
        }
        resolve({ code: code ?? 1 });
      };
      setImmediate(() => setImmediate(settle));
    });
  });
}

async function transcribe(root: string, manifest: Manifest, bag: FlagBag, pathEnv: string): Promise<number> {
  const input = bag.input;
  const language = bag.language;
  const threads = bag.threads;
  const maxSeconds = bag.maxSeconds;
  if (input === undefined || language === undefined || threads === undefined || maxSeconds === undefined) return fail(EXIT.usage, "usage");
  if (!input.startsWith("/") || !CHOICE.test(language) || !POSITIVE.test(threads) || !POSITIVE.test(maxSeconds)) return fail(EXIT.usage, "usage");
  const cap = Number(maxSeconds);
  const missing = missingParts(root, pathEnv, manifest);
  if (missing.length > 0) return fail(EXIT.notReady, `missing: ${missing.join(",")}`);
  const ffmpeg = commandOnPath("ffmpeg", pathEnv);
  const whisper = join(root, "bin", "whisper-cli");
  const model = join(root, "models", manifest.modelFile);
  if (ffmpeg === null) return fail(EXIT.notReady, "missing: ffmpeg");
  const dir = mkdtempSync(join(tmpdir(), "morndo-transcribe-"));
  scratches.add(dir);
  try {
    const wav = join(dir, "in.wav");
    let converted: Child;
    try {
      converted = await runChild(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-t", String(cap + 1), "-i", input, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-y", wav], dir);
    } catch (error) {
      if (error instanceof StoppedRun) return onStop(error.signal);
      const code = (error as NodeJS.ErrnoException).code;
      return fail(code === "ENOENT" ? EXIT.notReady : EXIT.unreadable, "ffmpeg failed");
    }
    if (converted.code !== 0) return fail(EXIT.unreadable, "not audio");
    const duration = wavDurationFile(wav);
    if (duration === "engine") return fail(EXIT.engine, "wav length");
    if (duration === null) return fail(EXIT.unreadable, "not audio");
    if (duration > cap * 1000) return fail(EXIT.tooLong, "too long");
    const out = join(dir, "out");
    let heard: Child;
    try {
      heard = await runChild(whisper, ["-m", model, "-f", wav, "-l", whisperLanguage(language), "-t", threads, "-np", "-oj", "-of", out], dir);
    } catch (error) {
      if (error instanceof StoppedRun) return onStop(error.signal);
      const code = (error as NodeJS.ErrnoException).code;
      return fail(code === "ENOENT" ? EXIT.notReady : EXIT.engine, "whisper-cli failed");
    }
    if (heard.code !== 0) return fail(EXIT.engine, "whisper-cli failed");
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(`${out}.json`, "utf8"));
    } catch {
      return fail(EXIT.engine, "whisper-cli wrote no json");
    }
    const mapped = mapWhisper(parsed, duration);
    if (mapped === null) return fail(EXIT.engine, "whisper-cli json was not protocol 1");
    return finish(mapped);
  } finally {
    dropScratch(dir);
  }
}

export async function main(argv: readonly string[], binDir: string): Promise<number> {
  bindStops();
  const root = join(binDir, "..");
  const pathEnv = process.env.PATH ?? "";
  const [cmd, ...rest] = argv;
  if (cmd === "probe") {
    if (rest.length !== 1 || rest[0] !== "--json") return fail(EXIT.usage, "usage");
    return finish(probeDocument(root, pathEnv));
  }
  if (cmd !== "run") return fail(EXIT.usage, "usage");
  const bag = flags(rest);
  if (bag === null || !bag.json) return fail(EXIT.usage, "usage");
  const manifest = readManifest(root);
  if (manifest === null) return fail(EXIT.notReady, "missing: plugin");
  return transcribe(root, manifest, bag, pathEnv);
}
