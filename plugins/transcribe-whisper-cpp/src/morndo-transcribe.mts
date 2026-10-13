// morndo-transcribe, plugin protocol 1 (ADR-0021, design §5). The hub spawns the CommonJS shim beside
// this file with an argument vector and never a shell. The model, whisper-cli and plugin.json live in
// the install directory (design §7). Audio is converted with the system's ffmpeg to 16 kHz mono WAV, then
// whisper-cli writes its JSON, which this maps to one protocol document on stdout. Nothing here uses the
// network. whisper.cpp's -oj offsets are milliseconds: examples/cli/cli.cpp writes t0 * 10, and t0 is
// whisper's 10 ms unit (v1.9.5, read 2026-10-13).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const EXIT = { usage: 2, unreadable: 3, tooLong: 4, notReady: 5, engine: 1 } as const;
// Node's default SIGTERM and SIGINT end the process without running an async `finally`, so the converted
// clip would stay under the temp directory. The handler removes it, then exits.
let scratch: string | null = null;
const children = new Set<ChildProcess>();

function clearScratch(): void {
  const dir = scratch;
  scratch = null;
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
}

function onStop(signal: NodeJS.Signals): void {
  for (const child of children) {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
  clearScratch();
  process.exit(signal === "SIGINT" ? 130 : 143);
}

let stopsBound = false;
function bindStops(): void {
  if (stopsBound) return;
  stopsBound = true;
  process.on("SIGTERM", () => onStop("SIGTERM"));
  process.on("SIGINT", () => onStop("SIGINT"));
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

// A 16-bit PCM WAV. Duration is the data chunk divided by the fmt chunk's rate, channels and width.
// ffmpeg writes extra chunks (LIST, fact); those are skipped. A file that is not WAVE, or whose fmt
// is not PCM, has no duration we can trust.
export function wavDurationMs(bytes: Uint8Array): number | null {
  if (bytes.length < 12) return null;
  if (ascii(bytes, 0, "RIFF") === false || ascii(bytes, 8, "WAVE") === false) return null;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  let dataBytes = -1;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
    const size = readU32(bytes, offset + 4);
    if (size === null) return null;
    const body = offset + 8;
    if (body + size > bytes.length) return null;
    if (id === "fmt ") {
      if (size < 16) return null;
      const format = readU16(bytes, body);
      channels = readU16(bytes, body + 2) ?? 0;
      rate = readU32(bytes, body + 4) ?? 0;
      bits = readU16(bytes, body + 14) ?? 0;
      if (format !== 1) return null;
    } else if (id === "data") {
      dataBytes = size;
    }
    offset = body + size + (size % 2);
  }
  if (rate < 1 || channels < 1 || bits < 8 || bits % 8 !== 0 || dataBytes < 0) return null;
  const block = channels * (bits / 8);
  if (block < 1 || dataBytes % block !== 0) return null;
  return Math.round((dataBytes / block / rate) * 1000);
}

function ascii(bytes: Uint8Array, at: number, word: string): boolean {
  for (let i = 0; i < word.length; i++) if (bytes[at + i] !== word.charCodeAt(i)) return false;
  return true;
}

function readU16(bytes: Uint8Array, at: number): number | null {
  if (at + 2 > bytes.length) return null;
  return bytes[at]! | (bytes[at + 1]! << 8);
}

function readU32(bytes: Uint8Array, at: number): number | null {
  if (at + 4 > bytes.length) return null;
  return (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0;
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

function absent(root: string, pathEnv: string): { missing: string[]; manifest: Manifest | null } {
  const missing: string[] = [];
  if (commandOnPath("ffmpeg", pathEnv) === null) missing.push("ffmpeg");
  if (!executable(join(root, "bin", "whisper-cli"))) missing.push("whisper-cli");
  const manifest = readManifest(root);
  if (manifest === null) missing.push("plugin");
  else if (!statFile(join(root, "models", manifest.modelFile))) missing.push("model");
  return { missing, manifest };
}

function statFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function probeDocument(root: string, pathEnv: string): ProbeBody {
  const { missing, manifest } = absent(root, pathEnv);
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

type Child = { code: number; stderr: string };

function runChild(cmd: string, args: string[], cwd: string): Promise<Child> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    children.add(child);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      children.delete(child);
      resolve({ code: code ?? 1, stderr });
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
  const { missing } = absent(root, pathEnv);
  if (missing.length > 0) return fail(EXIT.notReady, `missing: ${missing.join(",")}`);
  const ffmpeg = commandOnPath("ffmpeg", pathEnv);
  const whisper = join(root, "bin", "whisper-cli");
  const model = join(root, "models", manifest.modelFile);
  if (ffmpeg === null) return fail(EXIT.notReady, "missing: ffmpeg");
  const dir = mkdtempSync(join(tmpdir(), "morndo-transcribe-"));
  scratch = dir;
  try {
    const wav = join(dir, "in.wav");
    let converted: Child;
    try {
      converted = await runChild(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", input, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return fail(code === "ENOENT" ? EXIT.notReady : EXIT.unreadable, "ffmpeg failed");
    }
    if (converted.code !== 0) return fail(EXIT.unreadable, "not audio");
    const duration = wavDurationMs(readFileSync(wav));
    if (duration === null) return fail(EXIT.unreadable, "not audio");
    if (duration > cap * 1000) return fail(EXIT.tooLong, "too long");
    const out = join(dir, "out");
    let heard: Child;
    try {
      heard = await runChild(whisper, ["-m", model, "-f", wav, "-l", language, "-t", threads, "-np", "-oj", "-of", out], dir);
    } catch (error) {
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
    clearScratch();
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
