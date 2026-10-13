// The Transcriber port's contract (design §4, §13). One suite, run against MemoryTranscriber here and, in the hub
// PR, against ProcessTranscriber with the fixture plugin. A fake that ignores the abort signal stays pending, so
// the abort case fails. A process adapter reports the pids it started; a timeout must leave that group dead.
import { describe, expect, it } from "vitest";
import type { EngineText } from "@morndo/domain";
import type { TranscribeInput, Transcriber, TranscriberProbe } from "../src/index.ts";
import { SENTENCE } from "./answers.mjs";
import { alive, until } from "./proc.ts";

export type { TranscribeInput, Transcriber, TranscriberProbe };

export type ContractSubject = {
  transcriber: Transcriber;
  /** True once the run is in progress, so an abort lands after it started. A process adapter uses group() instead. */
  started?: () => boolean;
  /** Pids the adapter started for the run in progress. Absent for an in-memory fake. */
  group?: () => readonly number[];
};

function leaked(error: unknown, sentence: string): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes(sentence) || (error.stack ?? "").includes(sentence);
}
const HEARD: EngineText = {
  language: "de", durationMs: 5200, segments: [{ startMs: 0, endMs: 5200, text: SENTENCE }],
};

const call = (path: string, signal: AbortSignal): TranscribeInput =>
  ({ path, language: "auto", threads: 1, maxSeconds: 600, signal });

type Settled<T> = { kind: "value"; value: T } | { kind: "error"; error: unknown } | { kind: "hung" };

function settle<T>(pending: Promise<T>, ms: number): Promise<Settled<T>> {
  return Promise.race([
    pending.then(value => ({ kind: "value" as const, value }), error => ({ kind: "error" as const, error })),
    new Promise<Settled<T>>(resolve => setTimeout(() => resolve({ kind: "hung" }), ms)),
  ]);
}

export function transcriberContract(make: () => ContractSubject): void {
  describe("transcriber contract", () => {
    it("probes a ready engine with a model and a cap", async () => {
      expect(await make().transcriber.probe()).toEqual({
        ready: true, engine: "fixture-ear", engineVersion: "1.0.0", model: "tiny-fixture",
        languages: "multi", maxSeconds: 600,
      });
    });

    it("returns the heard segments for a run", async () => {
      const signal = new AbortController().signal;
      expect(await make().transcriber.transcribe(call("/audio/note.wav", signal))).toEqual({ ok: true, value: HEARD });
    });

    it("refuses an unreadable file, a file past the cap, and an engine that is not ready", async () => {
      const signal = () => new AbortController().signal;
      const tx = make().transcriber;
      expect(await tx.transcribe(call("/audio/unreadable.bin", signal()))).toEqual({ ok: false, error: "unreadable" });
      expect(await tx.transcribe(call("/audio/too-long.wav", signal()))).toEqual({ ok: false, error: "too_long" });
      expect(await tx.transcribe(call("/audio/not-ready.wav", signal()))).toEqual({ ok: false, error: "not_ready" });
    });

    it("an abort mid-run ends with no text", async () => {
      const { transcriber, started, group } = make();
      const ac = new AbortController();
      const pending = transcriber.transcribe(call("/audio/hang.wav", ac.signal));
      const began = group ? () => group().length > 0 : started;
      if (!began) throw new Error("abort mid-run needs started() or group()");
      expect(await until(began, 2000)).toBe(true);
      ac.abort();
      const outcome = await settle(pending, 500);
      expect(outcome.kind).toBe("error");
      if (outcome.kind !== "error") return;
      expect(outcome.error).toMatchObject({ name: "AbortError" });
      expect(leaked(outcome.error, SENTENCE)).toBe(false);
    });

    it("the leak check reads an error's message and its stack, which stringify skips", () => {
      const loud = new Error(SENTENCE);
      expect(JSON.stringify(loud)).not.toContain(SENTENCE);
      expect(leaked(loud, SENTENCE)).toBe(true);
      const stacked = new Error("aborted");
      stacked.stack = `at run (${SENTENCE})`;
      expect(stacked.message).not.toContain(SENTENCE);
      expect(leaked(stacked, SENTENCE)).toBe(true);
    });

    it("a timeout aborts the run with no text, and a process group it started is gone", async () => {
      const { transcriber, group } = make();
      const ac = new AbortController();
      const pending = transcriber.transcribe(call("/audio/hang.wav", ac.signal));
      let pids: readonly number[] = [];
      if (group) {
        expect(await until(() => group().length > 0, 2000)).toBe(true);
        pids = group();
        expect(pids.map(pid => alive(pid))).toEqual(pids.map(() => true));
      }
      ac.abort();
      const outcome = await settle(pending, 500);
      expect(outcome.kind).toBe("error");
      if (outcome.kind !== "error") return;
      expect(outcome.error).toMatchObject({ name: "AbortError" });
      expect(leaked(outcome.error, SENTENCE)).toBe(false);
      if (group) {
        expect(pids.length > 0).toBe(true);
        expect(await until(() => pids.every(pid => !alive(pid)), 2000)).toBe(true);
        expect(pids.map(pid => alive(pid))).toEqual(pids.map(() => false));
      }
    });
  });
}
