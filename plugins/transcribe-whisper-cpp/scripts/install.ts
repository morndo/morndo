// Opt-in install of the whisper.cpp plugin (ADR-0021 decision 5, design §7). Run from a checkout:
//   npm run plugin:transcribe -- --model base
// It builds the pinned tag, downloads one pinned model, checks the sha256, and writes
// <MORNDO_HOME>/plugins/transcribe. MORNDO_HOME defaults to ~/.local/share/morndo; --home overrides it
// so a trial install never touches a live hub. The build runs under nice -n 10.
//
// Pins checked 2026-10-13:
//   whisper.cpp v1.9.5, commit d1be6fde11ac6e0407606b4e42fe72d34add8037, published 2026-10-06
//   https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.5
//   https://github.com/ggml-org/whisper.cpp/commit/d1be6fde11ac6e0407606b4e42fe72d34add8037
//   model sizes and sha256 from https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main
//   SHA1 list: https://github.com/ggml-org/whisper.cpp/blob/v1.9.5/models/README.md
//   GGML_METAL defaults on for Apple and off otherwise (ggml/CMakeLists.txt at that commit). This
//   script does not pass GGML_METAL, so that default stands. BUILD_SHARED_LIBS is OFF.
//   The resolve URL redirects to a host under .hf.co (seen: us.aws.cdn.hf.co). The sha256 is the check
//   that the bytes are the pin; the host check refuses any other site.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { availableParallelism, homedir, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commandOnPath } from "../src/morndo-transcribe.mts";
import { Readable, type Writable } from "node:stream";

const PACKAGE = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";
const GIB = 1024 ** 3;

export const MODEL_IDS = ["base", "small", "turbo"] as const;
export type ModelId = (typeof MODEL_IDS)[number];

export type InstallRequest =
  | { ok: true; model: ModelId | null; home: string | null }
  | { ok: false; error: string };

type ModelPin = { model: string; file: string; bytes: number; sha256: string; url: string };
export type Pins = {
  version: string;
  protocol: 1;
  engine: string;
  engineVersion: string;
  tag: string;
  commit: string;
  repository: string;
  languages: "multi";
  maxSeconds: number;
  models: Record<ModelId, ModelPin>;
};

export function parseBuildFlags(text: string): string[] {
  return text.split("\n").map(line => line.trim()).filter(line => line !== "");
}

export function loadBuildFlags(read: () => string): string[] {
  return parseBuildFlags(read());
}

let cachedFlags: string[] | undefined;
export function buildFlags(): string[] {
  if (cachedFlags === undefined) {
    cachedFlags = loadBuildFlags(() => readFileSync(join(PACKAGE, "build-flags.txt"), "utf8"));
  }
  return cachedFlags;
}

export function buildDir(src: string, flags: readonly string[]): string {
  const key = createHash("sha256").update(flags.join("\n")).digest("hex").slice(0, 16);
  return join(src, "build", key);
}

export function pruneBuildDirs(src: string, keep: string): void {
  const root = join(src, "build");
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(root, name);
    if (full === keep) continue;
    rmSync(full, { recursive: true, force: true });
  }
}

const UBUNTU: Record<string, string> = { git: "git", cmake: "cmake", make: "make", "g++": "g++", ffmpeg: "ffmpeg" };
const BREW: Record<string, string> = { git: "git", cmake: "cmake", ffmpeg: "ffmpeg" };
const TOOLS = ["git", "cmake", "make", "g++", "ffmpeg"] as const;

export function suggestedModel(cores: number, memoryBytes: number): "small" | "turbo" {
  return cores >= 4 && memoryBytes >= 4 * GIB ? "turbo" : "small";
}

// os.freemem() is "the amount of free system memory in bytes" (https://nodejs.org/docs/latest-v24.x/api/os.html#osfreemem,
// read 2026-10-13). Node 24.21.0 bundles libuv 1.52.1, whose Darwin uv_get_free_memory is host_statistics
// free_count only (https://github.com/libuv/libuv/blob/v1.52.1/src/unix/darwin.c). os.totalmem() is the
// machine's hw.memsize (https://nodejs.org/docs/latest-v24.x/api/os.html#ostotalmem, same date). Node 24.21
// does not export an available-memory function. Linux reports MemAvailable in /proc/meminfo; that is the
// budget there. Everywhere else, including macOS, the budget is total memory.
export function memAvailableFrom(meminfo: string): number | null {
  const match = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo);
  return match?.[1] !== undefined ? Number(match[1]) * 1024 : null;
}

export function memoryBudget(platform: string, totalBytes: number, availableBytes: number | null): number {
  if (platform === "linux" && availableBytes !== null) return availableBytes;
  return totalBytes;
}

function readMemAvailable(): number | null {
  try {
    return memAvailableFrom(readFileSync("/proc/meminfo", "utf8"));
  } catch {
    return null;
  }
}

export function toolMessage(missing: readonly string[]): string {
  const lines = [`Missing ${missing.join(", ")}.`];
  const ubuntu = missing.map(name => UBUNTU[name]).filter((name): name is string => name !== undefined);
  const brew = missing.map(name => BREW[name]).filter((name): name is string => name !== undefined);
  if (ubuntu.length > 0) lines.push(`Ubuntu: sudo apt-get install -y ${ubuntu.join(" ")}`);
  if (brew.length > 0) lines.push(`Homebrew: brew install ${brew.join(" ")}`);
  if (missing.includes("g++") || missing.includes("make")) lines.push("macOS: xcode-select --install");
  return lines.join("\n");
}

function isModelId(value: string): value is ModelId {
  return value === "base" || value === "small" || value === "turbo";
}

export function parseInstallArgs(argv: readonly string[]): InstallRequest {
  let model: ModelId | null = null;
  let home: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { ok: false, error: "help" };
    if (arg !== "--model" && arg !== "--home") return { ok: false, error: `unknown argument ${arg ?? ""}` };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return { ok: false, error: `${arg} needs a value` };
    i += 1;
    if (arg === "--home") {
      home = value;
      continue;
    }
    if (model !== null) return { ok: false, error: "--model was given twice" };
    if (!isModelId(value)) return { ok: false, error: `unknown model ${value}` };
    model = value;
  }
  return { ok: true, model, home };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pinOf(value: unknown, id: ModelId): ModelPin | null {
  if (!isRecord(value)) return null;
  if (typeof value.model !== "string" || typeof value.file !== "string") return null;
  if (value.file !== basename(value.file)) return null;
  if (typeof value.bytes !== "number" || !Number.isInteger(value.bytes) || value.bytes < 1) return null;
  if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) return null;
  if (value.url !== `${MODEL_URL}${value.file}`) return null;
  if (id === "turbo" ? value.model !== "large-v3-turbo-q5_0" : value.model !== id) return null;
  return { model: value.model, file: value.file, bytes: value.bytes, sha256: value.sha256, url: value.url };
}

export function readPins(path: string): Pins {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || parsed.protocol !== 1 || parsed.languages !== "multi") throw new Error("plugin.json is not the pin file");
  if (typeof parsed.version !== "string" || typeof parsed.engineVersion !== "string" || typeof parsed.tag !== "string") throw new Error("plugin.json is not the pin file");
  if (typeof parsed.commit !== "string" || !/^[0-9a-f]{40}$/.test(parsed.commit)) throw new Error("plugin.json commit is not a sha");
  if (parsed.repository !== "https://github.com/ggml-org/whisper.cpp.git") throw new Error("plugin.json repository is not whisper.cpp");
  if (parsed.engine !== "whisper.cpp") throw new Error("plugin.json engine is not whisper.cpp");
  if (typeof parsed.maxSeconds !== "number" || parsed.maxSeconds !== 600) throw new Error("plugin.json maxSeconds is not 600");
  if (!isRecord(parsed.models)) throw new Error("plugin.json has no models");
  const models = {} as Record<ModelId, ModelPin>;
  for (const id of MODEL_IDS) {
    const pin = pinOf(parsed.models[id], id);
    if (pin === null) throw new Error(`plugin.json model ${id} does not match its pin`);
    models[id] = pin;
  }
  return {
    version: parsed.version,
    protocol: 1,
    engine: "whisper.cpp",
    engineVersion: parsed.engineVersion,
    tag: parsed.tag,
    commit: parsed.commit,
    repository: parsed.repository,
    languages: "multi",
    maxSeconds: 600,
    models,
  };
}

export function absentTools(): string[] {
  const pathEnv = process.env.PATH ?? "";
  return TOOLS.filter(name => commandOnPath(name, pathEnv) === null);
}

function cacheRoot(): string {
  const base = process.env.XDG_CACHE_HOME;
  const home = base !== undefined && base !== "" ? base : join(homedir(), ".cache");
  return join(home, "morndo", "transcribe");
}

function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${cmd} exited ${code ?? "signal"}`));
    });
  });
}

function capture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveRun(stdout.trim());
      else reject(new Error(stderr.trim() || `${cmd} exited ${code ?? "signal"}`));
    });
  });
}

async function sha256Of(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buf = chunk as Buffer;
    bytes += buf.length;
    hash.update(buf);
  }
  return { sha256: hash.digest("hex"), bytes };
}

function freeBytes(dir: string): number {
  const stats = statfsSync(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

// The model is copied, so the cache inode stays private. A reinstall still has the previous copy
// until the swap, so the copy is refused when the filesystem cannot hold a second one.
export function placeCachedFile(from: string, to: string, free: (dir: string) => number = freeBytes): void {
  const size = statSync(from).size;
  const room = free(dirname(to));
  if (room < size) throw new Error(`not enough free space to install the model (need ${size} bytes, ${room} free)`);
  copyFileSync(from, to);
}

function modelHost(hostname: string): boolean {
  return hostname === "huggingface.co" || hostname.endsWith(".huggingface.co") || hostname.endsWith(".hf.co");
}

function recoverInstall(dest: string): void {
  const parent = dirname(dest);
  const name = basename(dest);
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return;
  }
  let prevs = entries.filter(entry => entry.startsWith(`.${name}.prev-`));
  const nexts = entries.filter(entry => entry.startsWith(`.${name}.next-`));
  if (!existsSync(dest) && prevs.length > 0) {
    const ranked = prevs
      .map(entry => ({ entry, mtime: statSync(join(parent, entry)).mtimeMs }))
      .sort((left, right) => right.mtime - left.mtime);
    const keep = ranked[0];
    if (keep !== undefined) renameSync(join(parent, keep.entry), dest);
    prevs = ranked.slice(1).map(item => item.entry);
  }
  for (const leftover of [...prevs, ...nexts]) rmSync(join(parent, leftover), { recursive: true, force: true });
}

export async function replaceInstall(dest: string, fill: (dir: string) => Promise<void>): Promise<void> {
  const parent = dirname(dest);
  mkdirSync(parent, { recursive: true });
  recoverInstall(dest);
  const staging = join(parent, `.${basename(dest)}.next-${randomBytes(4).toString("hex")}`);
  mkdirSync(staging, { recursive: true });
  try {
    await fill(staging);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  const backup = join(parent, `.${basename(dest)}.prev-${randomBytes(4).toString("hex")}`);
  let moved = false;
  try {
    if (existsSync(dest)) {
      renameSync(dest, backup);
      moved = true;
    }
    renameSync(staging, dest);
  } catch (error) {
    if (moved && !existsSync(dest)) {
      try { renameSync(backup, dest); } catch { /* the backup directory is the previous install */ }
    }
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  rmSync(backup, { recursive: true, force: true });
}

function downloadError(error: NodeJS.ErrnoException): Error {
  if (error.code === "ENOSPC") return new Error("disk full while downloading the model");
  return new Error(`could not write the model (${error.code ?? error.message})`);
}

export async function writeModelBody(
  partial: string,
  chunks: AsyncIterable<Uint8Array>,
  open: (path: string) => Writable = (path) => createWriteStream(path),
): Promise<{ sha256: string; bytes: number }> {
  const out = open(partial);
  const hash = createHash("sha256");
  let bytes = 0;
  const iterator = chunks[Symbol.asyncIterator]();
  let stopped = false;
  const cancelBody = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await iterator.return?.(undefined);
  };
  try {
    await new Promise<void>((resolve, reject) => {
      // Attached before the first write. A disk error while waiting for drain rejects this
      // promise, stops the pump, and cancels the body so the read does not stay pending.
      let failing = false;
      const fail = (error: Error) => {
        if (failing) return;
        failing = true;
        void cancelBody().then(() => reject(error), () => reject(error));
      };
      out.on("error", (error: NodeJS.ErrnoException) => fail(downloadError(error)));
      const pump = async () => {
        try {
          while (!stopped) {
            const step = await iterator.next();
            if (step.done || stopped) break;
            const buf = Buffer.from(step.value);
            bytes += buf.length;
            hash.update(buf);
            if (!out.write(buf)) {
              await new Promise<void>((resolveDrain, rejectDrain) => {
                if (stopped) { resolveDrain(); return; }
                const onDrain = () => { out.off("error", onWriteError); resolveDrain(); };
                const onWriteError = () => { out.off("drain", onDrain); rejectDrain(new Error("write stopped")); };
                out.once("drain", onDrain);
                out.once("error", onWriteError);
              });
            }
          }
          if (!stopped) {
            out.end((error?: Error | null) => {
              if (error) fail(downloadError(error as NodeJS.ErrnoException));
              else resolve();
            });
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      };
      void pump();
    });
  } catch (error) {
    await cancelBody();
    out.destroy();
    rmSync(partial, { force: true });
    throw error;
  }
  return { sha256: hash.digest("hex"), bytes };
}

export async function commitModel(partial: string, dest: string, pin: { sha256: string; bytes: number }): Promise<void> {
  const got = await sha256Of(partial);
  if (got.sha256 !== pin.sha256 || got.bytes !== pin.bytes) {
    rmSync(partial, { force: true });
    throw new Error(`model sha256 or size does not match the pin (${got.bytes} bytes)`);
  }
  rmSync(dest, { force: true });
  renameSync(partial, dest);
}

async function download(url: string, dest: string, pin: ModelPin): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  const host = new URL(response.url).hostname;
  if (!modelHost(host)) throw new Error(`model download left the pinned host for ${host}`);
  if (!response.ok || response.body === null) throw new Error(`model download answered ${response.status}`);
  const partial = `${dest}.partial`;
  await writeModelBody(partial, Readable.fromWeb(response.body));
  await commitModel(partial, dest, pin);
}

async function ensureModel(pin: ModelPin, dest: string): Promise<void> {
  try {
    const got = await sha256Of(dest);
    if (got.sha256 === pin.sha256 && got.bytes === pin.bytes) return;
  } catch {
    // missing or unreadable: download
  }
  rmSync(dest, { force: true });
  process.stderr.write(`downloading ${pin.file}\n`);
  await download(pin.url, dest, pin);
}

async function ensureSource(pins: Pins, src: string): Promise<void> {
  let sha = "";
  try {
    sha = await capture("git", ["-C", src, "rev-parse", "HEAD"]);
  } catch {
    sha = "";
  }
  if (sha === pins.commit) return;
  rmSync(src, { recursive: true, force: true });
  mkdirSync(join(src, ".."), { recursive: true });
  process.stderr.write(`cloning whisper.cpp ${pins.tag}\n`);
  await run("git", ["clone", "--depth", "1", "--branch", pins.tag, pins.repository, src]);
  const head = await capture("git", ["-C", src, "rev-parse", "HEAD"]);
  if (head !== pins.commit) throw new Error(`whisper.cpp ${pins.tag} is ${head}, not the pinned ${pins.commit}`);
}

async function ensureBinary(src: string): Promise<string> {
  const flags = buildFlags();
  const dir = buildDir(src, flags);
  pruneBuildDirs(src, dir);
  const bin = join(dir, "bin", "whisper-cli");
  try {
    if (statSync(bin).isFile()) return bin;
  } catch {
    // build it
  }
  process.stderr.write("building whisper-cli\n");
  await run("cmake", ["-S", src, "-B", dir, ...flags]);
  await run("nice", ["-n", "10", "cmake", "--build", dir, "--target", "whisper-cli", "--parallel", String(availableParallelism())]);
  if (!statSync(bin).isFile()) throw new Error("whisper-cli was not produced");
  return bin;
}

function usage(): string {
  return [
    "npm run plugin:transcribe -- --model <base|small|turbo> [--home <dir>]",
    "With no --model, turbo is used on 4 or more cores with 4 GiB available (MemAvailable on Linux, total memory otherwise), and small otherwise.",
    "--home overrides MORNDO_HOME (default ~/.local/share/morndo).",
  ].join("\n");
}

async function install(request: { model: ModelId | null; home: string | null }): Promise<number> {
  const missing = absentTools();
  if (missing.length > 0) {
    process.stderr.write(`${toolMessage(missing)}\n`);
    return 1;
  }
  const pins = readPins(join(PACKAGE, "plugin.json"));
  const available = process.platform === "linux" ? readMemAvailable() : null;
  const id = request.model ?? suggestedModel(availableParallelism(), memoryBudget(process.platform, totalmem(), available));
  const pin = pins.models[id];
  const home = resolve(request.home ?? process.env.MORNDO_HOME ?? join(homedir(), ".local", "share", "morndo"));
  if (home === "/") throw new Error("refusing to install into /");
  const dest = join(home, "plugins", "transcribe");
  const cache = cacheRoot();
  const src = join(cache, "src", pins.commit);
  const modelCache = join(cache, "models", pin.sha256);
  mkdirSync(join(cache, "models"), { recursive: true });
  await ensureSource(pins, src);
  const whisper = await ensureBinary(src);
  await ensureModel(pin, modelCache);

  let probe = "";
  try {
    await replaceInstall(dest, async (dir) => {
      mkdirSync(join(dir, "bin"), { recursive: true, mode: 0o755 });
      mkdirSync(join(dir, "models"), { recursive: true, mode: 0o755 });
      copyFileSync(whisper, join(dir, "bin", "whisper-cli"));
      chmodSync(join(dir, "bin", "whisper-cli"), 0o755);
      placeCachedFile(modelCache, join(dir, "models", pin.file));
      chmodSync(join(dir, "models", pin.file), 0o644);
      copyFileSync(join(PACKAGE, "src", "morndo-transcribe.cjs"), join(dir, "bin", "morndo-transcribe"));
      chmodSync(join(dir, "bin", "morndo-transcribe"), 0o755);
      copyFileSync(join(PACKAGE, "src", "morndo-transcribe.mts"), join(dir, "bin", "morndo-transcribe.mts"));
      chmodSync(join(dir, "bin", "morndo-transcribe.mts"), 0o644);
      cpSync(join(PACKAGE, "LICENSES"), join(dir, "LICENSES"), { recursive: true });
      const installed = {
        name: "transcribe",
        version: pins.version,
        protocol: 1,
        engine: pins.engine,
        engineVersion: pins.engineVersion,
        model: pin.model,
        modelFile: pin.file,
        sha256: pin.sha256,
        languages: "multi" as const,
        maxSeconds: pins.maxSeconds,
      };
      writeFileSync(join(dir, "plugin.json"), `${JSON.stringify(installed, null, 2)}\n`, { mode: 0o644 });
      probe = await capture(process.execPath, [join(dir, "bin", "morndo-transcribe"), "probe", "--json"]);
      const body = JSON.parse(probe) as { ready?: boolean };
      if (body.ready !== true) throw new ProbeNotReady(probe);
    });
  } catch (error) {
    if (error instanceof ProbeNotReady) {
      process.stdout.write(`${error.probe}\nready: false\n`);
      return 1;
    }
    throw error;
  }
  process.stdout.write(`${probe}\nready: true\n`);
  return 0;
}

class ProbeNotReady extends Error {
  readonly probe: string;
  constructor(probe: string) {
    super("plugin probe was not ready");
    this.probe = probe;
  }
}

async function entry(argv: readonly string[]): Promise<number> {
  const parsed = parseInstallArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${usage()}\n`);
    if (parsed.error !== "help") process.stderr.write(`${parsed.error}\n`);
    return parsed.error === "help" ? 0 : 2;
  }
  return install(parsed);
}

const self = fileURLToPath(import.meta.url);
const invoked = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(self);
if (invoked) {
  let code = 1;
  try {
    code = await entry(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exit(code);
}
