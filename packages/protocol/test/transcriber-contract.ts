// The Transcriber port's contract (design §4, §13). One suite, run against MemoryTranscriber here and, in the hub
// PR, against ProcessTranscriber with the fixture plugin. A fake that ignores the abort signal stays pending, so
// the abort case fails. A process adapter reports the pids it started; a timeout must leave that group dead.
import { describe, expect, it } from "vitest";
import type { EngineText, Result, TranscriptionProblem } from "@morndo/domain";

export type TranscriberProbe =
  | { ready: true; engine: string; engineVersion: string; model: string; languages: "multi" | readonly string[]; maxSeconds: number }
  | { ready: false; reason: "missing" | "not_ready" | "protocol"; detail: string };

export type TranscribeInput = {
  path: string;
  language: string;
  threads: number;
  maxSeconds: number;
  signal: AbortSignal;
};

export type Transcriber = {
  probe(): Promise<TranscriberProbe>;
  transcribe(input: TranscribeInput): Promise<Result<EngineText, TranscriptionProblem>>;
};

export type ContractSubject = {
  transcriber: Transcriber;
  /** Pids the adapter started for the run in progress. Absent for an in-memory fake. */
  group?: () => readonly number[];
};

const SENTENCE = "Notiz an den Hafen: der Steg ist frei.";
const HEARD: EngineText = {
  language: "de", durationMs: 5200, segments: [{ startMs: 0, endMs: 5200, text: SENTENCE }],
};

const call = (path: string, signal: AbortSignal): TranscribeInput =>
  ({ path, language: "auto", threads: 1, maxSeconds: 600, signal });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return pred();
}

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
      const ac = new AbortController();
      const pending = make().transcriber.transcribe(call("/audio/hang.wav", ac.signal));
      ac.abort();
      const outcome = await settle(pending, 500);
      expect(outcome.kind).toBe("error");
      if (outcome.kind !== "error") return;
      expect(outcome.error).toMatchObject({ name: "AbortError" });
      expect(JSON.stringify(outcome.error)).not.toContain(SENTENCE);
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
      expect(JSON.stringify(outcome.error)).not.toContain(SENTENCE);
      if (group) {
        expect(pids.length > 0).toBe(true);
        expect(await until(() => pids.every(pid => !alive(pid)), 2000)).toBe(true);
        expect(pids.map(pid => alive(pid))).toEqual(pids.map(() => false));
      }
    });
  });
}
