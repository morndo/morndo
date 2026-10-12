// Scripted Transcriber for the contract suite (design §4). Answers are fixed by the input's basename, the same
// names the fixture plugin uses, so one suite can run against both. Time does not pass on its own: a delayed run
// finishes when the clock is moved, and an abort ends it even if the clock is moved afterwards.
import { err, ok, type EngineText, type Result, type TranscriptionProblem } from "@morndo/domain";
import type { TranscribeInput, Transcriber, TranscriberProbe } from "./transcriber-contract.ts";

const SENTENCE = "Notiz an den Hafen: der Steg ist frei.";

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

type Waiter = { until: number; wake: () => void };

export class ManualClock {
  private at = 0;
  private waiters: Waiter[] = [];

  advance(ms: number): void {
    this.at += ms;
    const due = this.waiters.filter(waiter => waiter.until <= this.at);
    this.waiters = this.waiters.filter(waiter => waiter.until > this.at);
    for (const waiter of due) waiter.wake();
  }

  wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        this.waiters = this.waiters.filter(waiter => waiter.wake !== wake);
        fn();
      };
      const wake = () => finish(resolve);
      const onAbort = () => finish(() => reject(abortError()));
      signal.addEventListener("abort", onAbort);
      if (signal.aborted) {
        onAbort();
        return;
      }
      if (!Number.isFinite(ms)) return;
      if (ms <= 0) {
        wake();
        return;
      }
      this.waiters.push({ until: this.at + ms, wake });
    });
  }
}

function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

function heard(language: string): EngineText {
  return { language, durationMs: 5200, segments: [{ startMs: 0, endMs: 5200, text: SENTENCE }] };
}

export class MemoryTranscriber implements Transcriber {
  constructor(private readonly clock = new ManualClock()) {}

  probe(): Promise<TranscriberProbe> {
    return Promise.resolve({
      ready: true, engine: "fixture-ear", engineVersion: "1.0.0", model: "tiny-fixture",
      languages: "multi", maxSeconds: 600,
    });
  }

  async transcribe(input: TranscribeInput): Promise<Result<EngineText, TranscriptionProblem>> {
    const base = baseName(input.path);
    if (base.startsWith("hang")) await this.clock.wait(Number.POSITIVE_INFINITY, input.signal);
    else if (base.startsWith("delay")) await this.clock.wait(1000, input.signal);
    else if (input.signal.aborted) throw abortError();
    if (base.startsWith("unreadable")) return err("unreadable");
    if (base.startsWith("too-long")) return err("too_long");
    if (base.startsWith("not-ready")) return err("not_ready");
    const language = input.language === "auto" ? "de" : input.language;
    return ok(heard(language));
  }
}
