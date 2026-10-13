// Design §13: the run step passes with networking disabled. unshare -rn gives the process a network
// namespace with no interfaces up, so a plugin that fetched a URL would fail.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { afterAll, expect, it } from "vitest";
import { parseRun } from "@morndo/protocol";
import { speechWav } from "./audio.ts";

const PHRASE = "The north harbor is clear at dawn.";
const bin = process.env.MORNDO_TRANSCRIBER;
const dir = mkdtempSync(join(tmpdir(), "morndo-offline-"));
const note = join(dir, "note.wav");

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

it.runIf(bin !== undefined)("a run with no network returns the sentence", async () => {
  if (bin === undefined) return;
  await speechWav(note, PHRASE);
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("unshare", [
      "-rn", process.execPath, bin, "run",
      "--input", note, "--language", "en", "--threads", "2", "--max-seconds", "600", "--json",
    ], {
      env: {
        PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
        HOME: "/tmp",
        LANG: "C",
        TMPDIR: tmpdir(),
      },
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
  expect(result.code, result.stderr).toBe(0);
  const parsed = parseRun(result.stdout);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.value.language).toBe("en");
  expect(parsed.value.segments.map(seg => seg.text).join(" ").toLowerCase()).toContain("harbor");
}, 120_000);

it.runIf(bin === undefined)("the no-network run waits for MORNDO_TRANSCRIBER", () => {
  expect(bin).toBeUndefined();
});
