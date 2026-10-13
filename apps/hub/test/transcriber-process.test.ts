// ProcessTranscriber (design §5, §13): the contract suite from the protocol package, against the fixture plugin,
// plus the host's own bounds. group() is passed so the timeout case checks the process group is dead.
import { readFileSync, readlinkSync } from "node:fs";
import { constants, getPriority } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SENTENCE } from "../../../packages/protocol/test/answers.mjs";
import { alive, until } from "../../../packages/protocol/test/proc.ts";
import { transcriberContract } from "../../../packages/protocol/test/transcriber-contract.ts";
import { processTranscriber } from "../src/adapters/transcriber-process.ts";

const FIXTURE = fileURLToPath(new URL("../../../packages/protocol/test/fixtures/fake-transcribe.mjs", import.meta.url));

const call = (path: string, signal = new AbortController().signal) =>
  ({ path, language: "auto" as const, threads: 1, maxSeconds: 600, signal });

transcriberContract(() => {
  const transcriber = processTranscriber(FIXTURE);
  return { transcriber, group: () => transcriber.group() };
});

describe("process host", () => {
  it("returns bad_output for a broken document and keeps neither the sentence nor a stderr token", async () => {
    const host = processTranscriber(FIXTURE);
    expect(await host.transcribe(call("/audio/bad-json.wav"))).toEqual({ ok: false, error: "bad_output" });
    expect(host.detail()).not.toContain(SENTENCE);
    expect(await host.transcribe(call("/audio/protocol-2.wav"))).toEqual({ ok: false, error: "bad_output" });
    expect(host.detail()).not.toContain("protocol");
    const huge = await host.transcribe(call("/audio/huge.wav"));
    expect(huge).toEqual({ ok: false, error: "bad_output" });
    expect(host.detail().length).toBeLessThan(4096);
    expect(host.detail()).not.toContain("x".repeat(64));
    const heard = await host.transcribe(call("/audio/stderr-token.wav"));
    expect(heard).toEqual({
      ok: true,
      value: { language: "de", durationMs: 5200, segments: [{ startMs: 0, endMs: 5200, text: SENTENCE }] },
    });
    expect(host.detail()).not.toContain("fixture-token-9f3a");
    expect(host.detail()).not.toContain(SENTENCE);
  });

  it("runs the child below normal, with only PATH, HOME, LANG and TMPDIR", async () => {
    const host = processTranscriber(FIXTURE);
    const ac = new AbortController();
    const pending = host.transcribe(call("/audio/hang.wav", ac.signal));
    expect(await until(() => host.group().length > 0, 2000)).toBe(true);
    const pid = host.group()[0];
    if (pid === undefined) throw new Error("the run started without a pid");
    const environ = () => {
      try { return readFileSync(`/proc/${pid}/environ`).toString("utf8").split("\0").filter(row => row !== ""); }
      catch { return []; }
    };
    expect(await until(() => environ().some(row => row.startsWith("TMPDIR=")), 2000)).toBe(true);
    expect(alive(pid)).toBe(true);
    // Node 24 os.constants.priority.PRIORITY_BELOW_NORMAL is nice 10 on Linux (docs fetched 2026-10-13).
    expect(constants.priority.PRIORITY_BELOW_NORMAL).toBe(10);
    expect(getPriority(pid)).toBe(10);
    const raw = environ();
    const keys = raw.map(row => row.split("=")[0] ?? "");
    const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
    const expected = ["HOME", "LANG", "PATH", "TMPDIR"].filter(key => key === "TMPDIR" || process.env[key]);
    expect(keys.sort(order)).toEqual(expected.sort(order));
    expect(raw.join("\0")).not.toContain("MORNDO_");
    const tmp = raw.find(row => row.startsWith("TMPDIR="))?.slice("TMPDIR=".length);
    expect(readlinkSync(`/proc/${pid}/cwd`)).toBe(tmp);
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
