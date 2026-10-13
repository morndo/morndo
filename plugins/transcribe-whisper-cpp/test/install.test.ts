import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { absentTools, parseInstallArgs, readPins, suggestedModel, toolMessage } from "../scripts/install.ts";

const GIB = 1024 ** 3;

describe("install choices", () => {
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
