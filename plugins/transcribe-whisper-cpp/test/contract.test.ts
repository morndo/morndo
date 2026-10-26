// The installed plugin against #46's transcriber contract. Skipped, with a reason, until MORNDO_TRANSCRIBER
// points at a ready install. The note is a made-up sentence spoken by ffmpeg's flite filter.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { transcriberContract } from "../../../packages/protocol/test/transcriber-contract.ts";
import { pcmWav, speechWav } from "./audio.ts";
import { contractSubject } from "./host.ts";

const PHRASE = "The north harbor is clear at dawn.";
const bin = process.env.MORNDO_TRANSCRIBER;
const ready = bin !== undefined && existsSync(bin);
const dir = mkdtempSync(join(tmpdir(), "morndo-contract-"));
const note = join(dir, "note.wav");
const unreadable = join(dir, "unreadable.bin");
const tooLong = join(dir, "too-long.wav");
const notReady = join(dir, "not-ready.wav");
const hang = join(dir, "hang.wav");
const broken = join(dir, "broken", "bin", "morndo-transcribe");

beforeAll(async () => {
  if (!ready || bin === undefined) return;
  await speechWav(note, PHRASE);
  writeFileSync(unreadable, "this is not audio\n");
  writeFileSync(tooLong, pcmWav(601));
  writeFileSync(notReady, pcmWav(1));
  writeFileSync(hang, pcmWav(30));
  const realRoot = dirname(dirname(bin));
  const root = join(dir, "broken");
  mkdirSync(join(root, "bin"), { recursive: true });
  copyFileSync(join(realRoot, "plugin.json"), join(root, "plugin.json"));
  copyFileSync(bin, broken);
  chmodSync(broken, 0o755);
  copyFileSync(join(realRoot, "bin", "morndo-transcribe.mts"), join(root, "bin", "morndo-transcribe.mts"));
});

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

if (ready && bin !== undefined) {
  transcriberContract(() => contractSubject(bin, broken, notReady), {
    probe: {
      ready: true, engine: "whisper.cpp", engineVersion: "1.9.5", model: "base",
      languages: "multi", maxSeconds: 600,
    },
    paths: { note, unreadable, tooLong, notReady, hang },
    heard: { language: "en", includes: "harbor" },
  }, 120_000);
}

it.runIf(!ready)("the installed plugin's contract waits for MORNDO_TRANSCRIBER", () => {
  expect(bin ?? "").toBe("");
});
