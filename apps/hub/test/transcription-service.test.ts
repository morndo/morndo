// TranscriptionService (design §9, §13): one class, FIFO, cancel, a timeout, and lost after a restart.
// The transcriber here is scripted. The process host has its own suite.
import { describe, expect, it, vi } from "vitest";
import {
  MAX_TEXT_BYTES, requestTranscription, utf8ByteLength,
  type EngineText, type Recording, type Result, type Transcription, type TranscriptionProblem,
} from "@morndo/domain";
import type { TranscribeInput, Transcriber, TranscriberProbe } from "@morndo/protocol";
import { until } from "../../../packages/protocol/test/proc.ts";
import { TranscriptionService, type TranscriptionStore } from "../src/application/transcription-service.ts";

const READY: TranscriberProbe = {
  ready: true, engine: "fixture-ear", engineVersion: "1.0.0", model: "tiny-fixture", languages: "multi", maxSeconds: 600,
};
const HEARD: EngineText = { language: "de", durationMs: 1000, segments: [{ startMs: 0, endMs: 1000, text: "Kurze Notiz." }] };

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

class Gate {
  calls: string[] = [];
  ready: TranscriberProbe = READY;
  answer: Result<EngineText, TranscriptionProblem> = { ok: true, value: HEARD };
  boom: Error | null = null;                                        // set: transcribe rejects outright, no abort
  private held = new Map<string, () => void>();

  readonly transcriber: Transcriber = {
    probe: async () => this.ready,
    transcribe: (input: TranscribeInput) => {
      this.calls.push(input.path);
      if (this.boom) return Promise.reject(this.boom);
      return new Promise((resolve, reject) => {
        const stop = () => reject(abortError());
        if (input.signal.aborted) { stop(); return; }
        input.signal.addEventListener("abort", stop);
        this.held.set(input.path, () => resolve(this.answer));
      });
    },
  };

  release(path: string): void {
    const finish = this.held.get(path);
    this.held.delete(path);
    finish?.();
  }
}

function memory(seed: Transcription[] = []): TranscriptionStore {
  const rows = seed.map(row => structuredClone(row));
  return {
    transcriptions: () => rows.map(row => structuredClone(row)),
    saveTranscription: row => {
      const i = rows.findIndex(r => r.id === row.id && r.recording.kind === row.recording.kind
        && r.recording.id === row.recording.id && r.language === row.language);
      if (i < 0) rows.push(structuredClone(row));
      else rows[i] = structuredClone(row);
    },
  };
}

const files = new Map<string, { path: string; size: number }>([
  ["a", { path: "/audio/a.wav", size: 12 }],
  ["b", { path: "/audio/b.wav", size: 12 }],
  ["hang", { path: "/audio/hang.wav", size: 12 }],
  ["long", { path: "/audio/long.wav", size: 12 }],
]);

function service(store: TranscriptionStore, gate: Gate, extra: { guard?: () => "off" | "load"; timeoutFor?: () => number; now?: () => number } = {}) {
  let guard: "off" | "load" = "off";
  const lines: string[] = [];
  const svc = new TranscriptionService({
    store, transcriber: gate.transcriber, now: extra.now ?? (() => 1_700_000_000_000),
    file: (recording: Recording) => files.get(recording.id) ?? null,
    guard: () => extra.guard?.() ?? guard,
    log: line => lines.push(line),
    probeTtlMs: 0,
    ...(extra.timeoutFor ? { timeoutFor: extra.timeoutFor } : {}),
  });
  return { svc, lines, setGuard: (g: "off" | "load") => { guard = g; } };
}

const body = (id: string, recording: string, language = "auto") =>
  ({ id, recording: { kind: "upload" as const, id: recording }, language });

describe("transcription service", () => {
  it("runs one at a time and starts the next when the first ends", async () => {
    const gate = new Gate();
    const { svc } = service(memory(), gate);
    await svc.start();
    const first = await svc.request(body("tx-a", "a"));
    const second = await svc.request(body("tx-b", "b"));
    expect(first.ok && first.value.state).toBe("running");
    expect(second.ok && second.value).toMatchObject({ state: "queued", position: 1, reason: "class" });
    expect(gate.calls).toEqual(["/audio/a.wav"]);
    gate.release("/audio/a.wav");
    expect(await until(() => svc.get("tx-a")?.state === "done" && svc.get("tx-b")?.state === "running", 2000)).toBe(true);
    expect(svc.get("tx-a")).toMatchObject({ state: "done", text: { text: "Kurze Notiz.", edited: false, engine: "fixture-ear", model: "tiny-fixture" } });
    expect(gate.calls).toEqual(["/audio/a.wav", "/audio/b.wav"]);
    svc.close();
  });

  it("a cancel while queued never starts, and a cancel while running ends cancelled", async () => {
    const gate = new Gate();
    const { svc } = service(memory(), gate);
    await svc.start();
    await svc.request(body("tx-a", "hang"));
    expect(await until(() => svc.get("tx-a")?.state === "running", 2000)).toBe(true);
    const queued = await svc.request(body("tx-b", "b"));
    expect(queued.ok && queued.value.state).toBe("queued");
    const dropped = svc.cancel("tx-b");
    expect(dropped.ok && dropped.value.state).toBe("cancelled");
    expect(gate.calls).toEqual(["/audio/hang.wav"]);
    const stopped = svc.cancel("tx-a");
    expect(stopped.ok && stopped.value.state).toBe("cancelled");
    expect(await until(() => svc.get("tx-a")?.state === "cancelled", 2000)).toBe(true);
    expect(svc.get("tx-a")?.text).toBeNull();
    expect(gate.calls).toEqual(["/audio/hang.wav"]);
    svc.close();
  });

  it("a running row is lost once across a restart, and a queued row waits again", async () => {
    const made = requestTranscription([], { id: "tx-run", recording: { kind: "upload", id: "a" }, sizeBytes: 12, language: "auto" }, 10, { present: true, maxSeconds: 600 });
    if (!made.ok) throw new Error(made.error);
    const running: Transcription = { ...made.value, state: "running", startedAt: 20 };
    const waiting = requestTranscription([], { id: "tx-wait", recording: { kind: "upload", id: "b" }, sizeBytes: 12, language: "auto" }, 11, { present: true, maxSeconds: 600 });
    if (!waiting.ok) throw new Error(waiting.error);
    const store = memory([running, waiting.value]);
    const gate = new Gate();
    const first = service(store, gate, { now: () => 50 });
    expect(first.svc.get("tx-run")).toMatchObject({ state: "lost", outcome: "lost", endedAt: 50, text: null });
    await first.svc.start();
    expect(await until(() => first.svc.get("tx-wait")?.state === "running", 2000)).toBe(true);
    first.svc.close();
    const again = service(store, new Gate(), { now: () => 80 });
    expect(again.svc.get("tx-run")).toMatchObject({ state: "lost", endedAt: 50 });
    again.svc.close();
  });

  it("a guard over the line keeps the row queued until the line clears", async () => {
    const gate = new Gate();
    const { svc, setGuard } = service(memory(), gate);
    await svc.start();
    setGuard("load");
    const row = await svc.request(body("tx-a", "a"));
    expect(row.ok && row.value).toMatchObject({ state: "queued", reason: "load", position: 1 });
    expect(gate.calls).toEqual([]);
    setGuard("off");
    svc.tick();
    expect(await until(() => svc.get("tx-a")?.state === "running", 2000)).toBe(true);
    expect(gate.calls).toEqual(["/audio/a.wav"]);
    svc.close();
  });

  it("re-checks the queue on its own schedule, as the jobs' minute sweep does", async () => {
    vi.useFakeTimers();
    try {
      const gate = new Gate();
      const { svc, setGuard } = service(memory(), gate);
      await svc.start();
      setGuard("load");
      const row = await svc.request(body("tx-a", "a"));
      expect(row.ok && row.value.state).toBe("queued");
      setGuard("off");
      await vi.advanceTimersByTimeAsync(60_000);        // no request, cancel or finish arrives: the sweep alone starts it
      expect(svc.get("tx-a")?.state).toBe("running");
      expect(gate.calls).toEqual(["/audio/a.wav"]);
      svc.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a launch that finds the file gone fails its row and hands the slot on", async () => {
    files.set("a-swept", { path: "/audio/a-swept.wav", size: 12 });   // sorts before "b": with the clock fixed, FIFO
    try {                                                             // breaks the tie by key
      const gate = new Gate();
      const { svc, setGuard } = service(memory(), gate);
      await svc.start();
      setGuard("load");                                        // both accepted while the guard holds the line
      await svc.request(body("tx-a", "a-swept"));
      await svc.request(body("tx-b", "b"));
      files.delete("a-swept");                                 // the upload's TTL sweeps it before any start
      setGuard("off");
      svc.tick();
      expect(svc.get("tx-a")).toMatchObject({ state: "failed", problem: "unreadable" });
      expect(await until(() => svc.get("tx-b")?.state === "running", 2000)).toBe(true);
      expect(gate.calls).toEqual(["/audio/b.wav"]);
      svc.close();
    } finally {
      files.delete("a-swept");
    }
  });

  it("answers the row this request made, not the first live row that shares its id", async () => {
    const gate = new Gate();
    const { svc } = service(memory(), gate);
    await svc.start();
    await svc.request(body("v1", "hang"));
    expect(await until(() => svc.get("v1")?.state === "running", 2000)).toBe(true);
    const made = await svc.request(body("v1", "b"));        // the same id on another recording is its own attempt
    expect(made.ok && made.value).toMatchObject({ id: "v1", recording: { kind: "upload", id: "b" }, state: "queued", position: 1 });
    svc.close();
  });

  it("the same recording and language returns the attempt already in flight", async () => {
    const gate = new Gate();
    const { svc } = service(memory(), gate);
    await svc.start();
    const first = await svc.request(body("tx-a", "hang"));
    const again = await svc.request(body("tx-other", "hang"));
    expect(first.ok && again.ok && again.value.id).toBe("tx-a");
    expect(gate.calls).toEqual(["/audio/hang.wav"]);
    svc.close();
  });

  it("cuts text past 64 KiB and refuses a recording past the cap", async () => {
    const gate = new Gate();
    gate.answer = { ok: true, value: { language: "de", durationMs: 1000, segments: [{ startMs: 0, endMs: 1000, text: "y".repeat(70_000) }] } };
    const { svc } = service(memory(), gate);
    await svc.start();
    const accepted = await svc.request(body("tx-cut", "a"));
    expect(accepted.ok && accepted.value.state).toBe("running");
    gate.release("/audio/a.wav");
    expect(await until(() => svc.get("tx-cut")?.state === "done", 2000)).toBe(true);
    const words = svc.get("tx-cut")?.text?.text ?? "";
    expect(words.endsWith("[truncated]")).toBe(true);
    expect(utf8ByteLength(words)).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    svc.close();

    const slow = new Gate();
    slow.answer = { ok: true, value: { language: "de", durationMs: 601_000, segments: [{ startMs: 0, endMs: 601_000, text: "too much" }] } };
    const second = service(memory(), slow);
    await second.svc.start();
    await second.svc.request(body("tx-long", "long"));
    slow.release("/audio/long.wav");
    expect(await until(() => second.svc.get("tx-long")?.state === "failed", 2000)).toBe(true);
    expect(second.svc.get("tx-long")).toMatchObject({ state: "failed", problem: "too_long", text: null });
    second.svc.close();
  });

  it("times out a run that does not finish", async () => {
    const gate = new Gate();
    const { svc } = service(memory(), gate, { timeoutFor: () => 40 });
    await svc.start();
    await svc.request(body("tx-hang", "hang"));
    expect(await until(() => svc.get("tx-hang")?.state === "timed_out", 2000)).toBe(true);
    expect(svc.get("tx-hang")?.text).toBeNull();
    svc.close();
  });

  it("close() launches nothing more and leaves the interrupted run to the restart's lost", async () => {
    const gate = new Gate();
    const store = memory();
    const { svc } = service(store, gate);
    await svc.start();
    await svc.request(body("tx-a", "hang"));
    expect(await until(() => svc.get("tx-a")?.state === "running", 2000)).toBe(true);
    await svc.request(body("tx-b", "b"));
    svc.close();
    await new Promise(r => setTimeout(r, 50));               // let the abort's rejection run its microtasks
    expect(gate.calls).toEqual(["/audio/hang.wav"]);         // the queued row was never launched after close
    expect(store.transcriptions().find(row => row.id === "tx-b")?.state).toBe("queued");
    // The principal never cancelled: the run keeps no recorded end, so the next start marks it lost (TX4).
    expect(store.transcriptions().find(row => row.id === "tx-a")?.state).toBe("running");
    const after = service(store, new Gate(), { now: () => 1_700_000_060_000 });
    expect(after.svc.get("tx-a")).toMatchObject({ state: "lost", outcome: "lost" });
    after.svc.close();
  });

  it("fails a queued row when the plugin is no longer ready, and logs the change", async () => {
    const gate = new Gate();
    const { svc, lines } = service(memory(), gate);
    await svc.start();
    expect(lines).toEqual(["transcription: on (fixture-ear tiny-fixture)"]);
    expect(svc.me()).toEqual({ engine: "fixture-ear", model: "tiny-fixture", languages: "multi", maxSeconds: 600 });
    await svc.request(body("tx-a", "hang"));
    expect(await until(() => svc.get("tx-a")?.state === "running", 2000)).toBe(true);
    await svc.request(body("tx-b", "b"));
    gate.ready = { ready: false, reason: "missing", detail: "missing" };
    await svc.refresh();
    expect(svc.get("tx-b")).toMatchObject({ state: "failed", problem: "not_ready" });
    expect(svc.get("tx-a")?.state).toBe("running");
    expect(svc.me()).toBe(false);
    expect(lines.at(-1)).toBe("transcription: off (missing)");
    svc.close();
  });

  it("a rejection that is not an abort is a failure, whichever reason an earlier attempt left", async () => {
    const gate = new Gate();
    const { svc } = service(memory(), gate, { timeoutFor: () => 40 });
    await svc.start();
    gate.boom = new Error("no space left on device");        // mkdtemp or spawn failing in the host
    await svc.request(body("tx-err", "a"));
    expect(await until(() => svc.get("tx-err")?.state === "failed", 2000)).toBe(true);
    expect(svc.get("tx-err")).toMatchObject({ state: "failed", problem: "engine", text: null });
    // The same recording timed out before (so its reason lingers), then the next attempt errors: the error is
    // still the error, not the earlier attempt's timed_out.
    gate.boom = null;
    await svc.request(body("tx-2", "hang"));
    expect(await until(() => svc.get("tx-2")?.state === "timed_out", 2000)).toBe(true);
    gate.boom = new Error("no space left on device");
    const again = await svc.request(body("tx-3", "hang"));   // TX3: a new attempt after the end
    expect(again.ok && again.value.id).toBe("tx-3");
    expect(await until(() => svc.get("tx-3")?.state === "failed", 2000)).toBe(true);
    expect(svc.get("tx-3")).toMatchObject({ state: "failed", problem: "engine", text: null });
    svc.close();
  });

  it("re-locates the plugin on each probe, so installing it turns the feature on without a restart", async () => {
    const gate = new Gate();
    const found: { transcriber: Transcriber | null; unavailable: TranscriberProbe | null } = {
      transcriber: null, unavailable: { ready: false, reason: "missing", detail: "missing" },
    };
    const lines: string[] = [];
    const svc = new TranscriptionService({
      store: memory(), transcriber: null, locate: () => found,
      now: () => 1_700_000_000_000, file: (recording: Recording) => files.get(recording.id) ?? null,
      log: line => lines.push(line), probeTtlMs: 0,
    });
    await svc.start();
    expect(svc.me()).toBe(false);                                     // /api/me keeps reporting the startup answer today
    found.transcriber = gate.transcriber;
    found.unavailable = null;
    await svc.refresh();
    expect(svc.me()).toMatchObject({ engine: "fixture-ear", model: "tiny-fixture" });
    expect(lines.at(-1)).toBe("transcription: on (fixture-ear tiny-fixture)");
    // The other way round: a binary that went group-writable after start is not run any more (design §6).
    found.transcriber = null;
    found.unavailable = { ready: false, reason: "not_ready", detail: "unsafe_permissions" };
    await svc.refresh();
    expect(svc.me()).toBe(false);
    expect(lines.at(-1)).toBe("transcription: off (not_ready)");
    svc.close();
  });
});
