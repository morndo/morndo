// The Transcriber port's contract (design §4, §13). One suite, run against MemoryTranscriber here, against the
// hub's process host with the fixture plugin, and against the whisper.cpp plugin. The fixture scene is the default,
// so those callers stay on the fixed sentence. The plugin passes its own scene: a real clip, and the words that
// clip must contain, because a real engine's timestamps are not the fixture's. A fake that ignores the abort
// signal stays pending, so the abort case fails. A process adapter reports the pids it started; a timeout must
// leave that group dead.
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

export type ContractHeard = EngineText | { language: string; includes: string };

export type ContractScene = {
  probe: Extract<TranscriberProbe, { ready: true }>;
  paths: { note: string; unreadable: string; tooLong: string; notReady: string; hang: string };
  heard: ContractHeard;
};

const FIXTURE_SCENE: ContractScene = {
  probe: {
    ready: true, engine: "fixture-ear", engineVersion: "1.0.0", model: "tiny-fixture",
    languages: "multi", maxSeconds: 600,
  },
  paths: {
    note: "/audio/note.wav",
    unreadable: "/audio/unreadable.bin",
    tooLong: "/audio/too-long.wav",
    notReady: "/audio/not-ready.wav",
    hang: "/audio/hang.wav",
  },
  heard: HEARD,
};

const call = (path: string, signal: AbortSignal, maxSeconds: number): TranscribeInput =>
  ({ path, language: "auto", threads: 1, maxSeconds, signal });

function keyword(heard: ContractHeard): heard is { language: string; includes: string } {
  return "includes" in heard;
}

type Settled<T> = { kind: "value"; value: T } | { kind: "error"; error: unknown } | { kind: "hung" };

function settle<T>(pending: Promise<T>, ms: number): Promise<Settled<T>> {
  return Promise.race([
    pending.then(value => ({ kind: "value" as const, value }), error => ({ kind: "error" as const, error })),
    new Promise<Settled<T>>(resolve => setTimeout(() => resolve({ kind: "hung" }), ms)),
  ]);
}

export function transcriberContract(make: () => ContractSubject, scene: ContractScene = FIXTURE_SCENE, timeoutMs = 20_000): void {
  const slow = (name: string, fn: () => unknown) => it(name, fn, timeoutMs);
  describe("transcriber contract", () => {
    const run = (path: string, signal: AbortSignal) => call(path, signal, scene.probe.maxSeconds);

    slow("probes a ready engine with a model and a cap", async () => {
      expect(await make().transcriber.probe()).toEqual(scene.probe);
    });

    slow("returns the heard segments for a run", async () => {
      const signal = new AbortController().signal;
      const result = await make().transcriber.transcribe(run(scene.paths.note, signal));
      if (keyword(scene.heard)) {
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.language).toBe(scene.heard.language);
        expect(result.value.segments.map(seg => seg.text).join(" ").toLowerCase()).toContain(scene.heard.includes);
        expect(result.value.segments.every(seg => seg.endMs >= seg.startMs && seg.endMs <= result.value.durationMs)).toBe(true);
        return;
      }
      expect(result).toEqual({ ok: true, value: scene.heard });
    });

    slow("refuses an unreadable file, a file past the cap, and an engine that is not ready", async () => {
      const signal = () => new AbortController().signal;
      const tx = make().transcriber;
      expect(await tx.transcribe(run(scene.paths.unreadable, signal()))).toEqual({ ok: false, error: "unreadable" });
      expect(await tx.transcribe(run(scene.paths.tooLong, signal()))).toEqual({ ok: false, error: "too_long" });
      expect(await tx.transcribe(run(scene.paths.notReady, signal()))).toEqual({ ok: false, error: "not_ready" });
    });

    slow("an abort mid-run ends with no text", async () => {
      const { transcriber, started, group } = make();
      const ac = new AbortController();
      const pending = transcriber.transcribe(run(scene.paths.hang, ac.signal));
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

    slow("the leak check reads an error's message and its stack, which stringify skips", () => {
      const loud = new Error(SENTENCE);
      expect(JSON.stringify(loud)).not.toContain(SENTENCE);
      expect(leaked(loud, SENTENCE)).toBe(true);
      const stacked = new Error("aborted");
      stacked.stack = `at run (${SENTENCE})`;
      expect(stacked.message).not.toContain(SENTENCE);
      expect(leaked(stacked, SENTENCE)).toBe(true);
    });

    slow("a timeout aborts the run with no text, and a process group it started is gone", async () => {
      const { transcriber, group } = make();
      const ac = new AbortController();
      const pending = transcriber.transcribe(run(scene.paths.hang, ac.signal));
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
