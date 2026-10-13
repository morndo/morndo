import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { commandOnPath } from "../src/morndo-transcribe.mts";
import { absentTools, buildDir, memAvailableFrom, memoryBudget, parseInstallArgs, readPins, replaceInstall, suggestedModel, toolMessage, writeModelBody } from "../scripts/install.ts";

const GIB = 1024 ** 3;

describe("install choices", () => {
  it("picks turbo from total memory on macOS and from MemAvailable on Linux", () => {
    expect(memAvailableFrom("MemTotal: 16000000 kB\nMemAvailable:    3145728 kB\n")).toBe(3_145_728 * 1024);
    expect(memAvailableFrom("MemTotal: 1 kB\n")).toBeNull();
    expect(memoryBudget("linux", 64 * GIB, 3 * GIB)).toBe(3 * GIB);
    expect(suggestedModel(4, memoryBudget("linux", 64 * GIB, 3 * GIB))).toBe("small");
    expect(memoryBudget("darwin", 64 * GIB, 200 * 1024 * 1024)).toBe(64 * GIB);
    expect(suggestedModel(4, memoryBudget("darwin", 64 * GIB, 200 * 1024 * 1024))).toBe("turbo");
    const help = spawnSync(process.execPath, [join(import.meta.dirname, "../scripts/install.ts"), "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stderr).toBe([
      "npm run plugin:transcribe -- --model <base|small|turbo> [--home <dir>]",
      "With no --model, turbo is used on 4 or more cores with 4 GiB available (MemAvailable on Linux, total memory otherwise), and small otherwise.",
      "--home overrides MORNDO_HOME (default ~/.local/share/morndo).",
      "",
    ].join("\n"));
  });

  it("suggests turbo on a roomy machine and small otherwise, and reads --model and --home", () => {
    expect(suggestedModel(4, 4 * GIB)).toBe("turbo");
    expect(suggestedModel(8, 8 * GIB)).toBe("turbo");
    expect(suggestedModel(3, 8 * GIB)).toBe("small");
    expect(suggestedModel(4, 4 * GIB - 1)).toBe("small");
    expect(parseInstallArgs(["--model", "base"])).toEqual({ ok: true, model: "base", home: null });
    expect(parseInstallArgs([])).toEqual({ ok: true, model: null, home: null });
    expect(parseInstallArgs(["--home", "/tmp/morndo-prefix", "--model", "small"])).toEqual({
      ok: true, model: "small", home: "/tmp/morndo-prefix",
    });
    expect(parseInstallArgs(["--model", "huge"])).toEqual({ ok: false, error: "unknown model huge" });
    expect(parseInstallArgs(["--model"])).toEqual({ ok: false, error: "--model needs a value" });
  });

  it("names the Ubuntu and Homebrew packages for a missing tool", () => {
    expect(toolMessage(["ffmpeg"])).toBe(
      "Missing ffmpeg.\nUbuntu: sudo apt-get install -y ffmpeg\nHomebrew: brew install ffmpeg",
    );
    expect(toolMessage(["g++", "cmake"])).toBe(
      "Missing g++, cmake.\nUbuntu: sudo apt-get install -y g++ cmake\nHomebrew: brew install cmake\nmacOS: xcode-select --install",
    );
  });

  it("reads the shipped pin file and refuses a model url that is not the pinned file", () => {
    const pins = readPins(join(import.meta.dirname, "../plugin.json"));
    expect(pins.tag).toBe("v1.9.5");
    expect(pins.models.base.url).toBe("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin");
    expect(pins.models.turbo.model).toBe("large-v3-turbo-q5_0");
    const dir = mkdtempSync(join(tmpdir(), "morndo-pins-"));
    const bad = join(dir, "plugin.json");
    const body = JSON.parse(JSON.stringify(pins)) as { models: { base: { url: string } } };
    body.models.base.url = "https://example.invalid/ggml-base.bin";
    writeFileSync(bad, JSON.stringify(body));
    expect(() => readPins(bad)).toThrow(/model base/);
  });

  it("a change of cmake flags uses a different build directory, and the workflow cache key includes them", () => {
    const flagKey = (flags: readonly string[]) => createHash("sha256").update(flags.join("\n")).digest("hex").slice(0, 16);
    const src = "/cache/src/d1be6fde11ac6e0407606b4e42fe72d34add8037";
    expect(buildDir(src, ["-DBUILD_SHARED_LIBS=OFF"])).toBe(join(src, "build", flagKey(["-DBUILD_SHARED_LIBS=OFF"])));
    expect(buildDir(src, ["-DBUILD_SHARED_LIBS=ON"])).toBe(join(src, "build", flagKey(["-DBUILD_SHARED_LIBS=ON"])));
    const workflow = readFileSync(join(import.meta.dirname, "../../../.github/workflows/transcription-plugin.yml"), "utf8");
    expect(workflow).toContain("hashFiles('plugins/transcribe-whisper-cpp/plugin.json', 'plugins/transcribe-whisper-cpp/scripts/install.ts')");
  });

  it("the plugin workflow runs when a file its tests depend on changes", () => {
    const workflow = readFileSync(join(import.meta.dirname, "../../../.github/workflows/transcription-plugin.yml"), "utf8");
    const paths = [
      "packages/domain/src/transcription.ts",
      "packages/protocol/src/index.ts",
      "packages/protocol/test/proc.ts",
      "packages/protocol/test/answers.mjs",
      "vitest.config.ts",
      "package.json",
    ];
    for (const path of paths) expect(workflow.split(`- "${path}"`).length - 1).toBe(2);
  });

  it("a failed install leaves the previous plugin in place", async () => {
    const root = mkdtempSync(join(tmpdir(), "morndo-swap-"));
    const dest = join(root, "transcribe");
    mkdirSync(dest);
    writeFileSync(join(dest, "marker"), "old");
    try {
      await expect(replaceInstall(dest, async () => { throw new Error("ENOSPC"); })).rejects.toThrow("ENOSPC");
      expect(readFileSync(join(dest, "marker"), "utf8")).toBe("old");
      expect(readdirSync(root)).toEqual(["transcribe"]);
      await replaceInstall(dest, async (dir) => { writeFileSync(join(dir, "marker"), "new"); });
      expect(readFileSync(join(dest, "marker"), "utf8")).toBe("new");
      expect(readdirSync(root)).toEqual(["transcribe"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a full disk removes the partial model and says the disk is full", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-disk-"));
    const partial = join(dir, "model.bin.partial");
    writeFileSync(partial, "started");
    const open = () => new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, _callback) {
        // A real write error arrives on a later turn, while the caller is waiting for drain.
        process.nextTick(() => {
          this.emit("error", Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }));
        });
      },
    });
    try {
      await expect(writeModelBody(partial, (async function* () { yield Buffer.from("model-bytes"); })(), open))
        .rejects.toThrow("disk full while downloading the model");
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a non-executable file as missing, the same way the plugin does", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-tools-"));
    writeFileSync(join(dir, "ffmpeg"), "#!/bin/sh\n");
    chmodSync(join(dir, "ffmpeg"), 0o644);
    writeFileSync(join(dir, "git"), "#!/bin/sh\n");
    chmodSync(join(dir, "git"), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = dir;
    try {
      expect(commandOnPath("ffmpeg", dir)).toBeNull();
      expect(commandOnPath("git", dir)).toBe(join(dir, "git"));
      expect(absentTools()).toEqual(["cmake", "make", "g++", "ffmpeg"]);
    } finally {
      process.env.PATH = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names every tool when PATH has none of them", () => {
    const saved = process.env.PATH;
    process.env.PATH = "/tmp/morndo-no-such-bin";
    try {
      expect(absentTools()).toEqual(["git", "cmake", "make", "g++", "ffmpeg"]);
    } finally {
      process.env.PATH = saved;
    }
  });
});
