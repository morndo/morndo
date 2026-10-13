// TranscriptionService (design §9, §13): one class, FIFO, cancel, a timeout, and lost after a restart.
// The transcriber here is scripted. The process host has its own suite.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_TEXT_BYTES, requestTranscription, utf8ByteLength,
  type EngineText, type Recording, type Result, type Transcription, type TranscriptionProblem,
} from "@morndo/domain";
import type { TranscribeInput, Transcriber, TranscriberProbe } from "@morndo/protocol";
import { until } from "../../../packages/protocol/test/proc.ts";
import { wavBytes } from "../../../packages/domain/test/audio-bytes.ts";
import { guardNow, watchMachine } from "../src/adapters/transcription-config.ts";
import { fileOnDisk, TranscriptionService, type TranscriptionStore } from "../src/application/transcription-service.ts";

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
      const owner = "endpointId" in row && typeof row.endpointId === "string" ? row.endpointId : "";
      const i = rows.findIndex(r => r.id === row.id && r.recording.kind === row.recording.kind
        && r.recording.id === row.recording.id && r.language === row.language
        && ("endpointId" in r && typeof r.endpointId === "string" ? r.endpointId : "") === owner);
      if (i < 0) rows.push(structuredClone(row));
      else rows[i] = structuredClone(row);
    },
  };
}

const files = new Map<string, { path: string; size: number; durationMs: number | null; owner?: string }>([
  ["a", { path: "/audio/a.wav", size: 12, durationMs: null }],
  ["b", { path: "/audio/b.wav", size: 12, durationMs: null }],
  ["hang", { path: "/audio/hang.wav", size: 12, durationMs: null }],
  ["long", { path: "/audio/long.wav", size: 12, durationMs: null }],
  ["short", { path: "/audio/short.wav", size: 12, durationMs: 10_000 }],
  ["over", { path: "/audio/over.wav", size: 12, durationMs: 900_000 }],
]);

// The port production wires: a file the caller may read, an upload only its own endpoint's (S2's rule).
const port = (recording: Recording, caller?: { endpointId: string }) => {
  const file = files.get(recording.id);
  if (!file) return null;
  if (file.owner && caller && file.owner !== caller.endpointId) return null;
  return file;
};

function service(store: TranscriptionStore, gate: Gate, extra: { guard?: () => "off" | "load" | "memory" | "unknown"; timeoutFor?: (durationMs: number) => number; now?: () => number } = {}) {
  let guard: "off" | "load" = "off";
  const lines: string[] = [];
  const svc = new TranscriptionService({
    store, transcriber: gate.transcriber, now: extra.now ?? (() => 1_700_000_000_000),
    file: port,
    guard: () => extra.guard?.() ?? guard,
    log: line => lines.push(line),
    probeTtlMs: 0,
    ...(extra.timeoutFor ? { timeoutFor: extra.timeoutFor } : {}),
  });
  return { svc, lines, setGuard: (g: "off" | "load") => { guard = g; } };
}

const body = (id: string, recording: string, language = "auto", endpointId = "ep-1") =>
  ({ id, recording: { kind: "upload" as const, id: recording }, language, caller: { endpointId } });

describe("transcription service", () => {
  it("tick spawns nothing while it reads the memory figure", async () => {
    let spawns = 0;
    const watched = watchMachine({ memAvailableMiB: 64 }, {
      platform: "darwin",
      vmStat: async () => {
        spawns += 1;
        return [
          "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
          "Pages free:                               100.",
          "Pages inactive:                            50.",
          "Pages speculative:                         25.",
        ].join("\n");
      },
    });
    const gate = new Gate();
    const { svc } = service(memory(), gate, {
      guard: () => guardNow({ memAvailableMiB: 64 }, watched.read),
    });
    await svc.start();
    const before = spawns;
    svc.tick();
    expect(spawns).toBe(before);
    await watched.refresh();
    expect(watched.read().memAvailableMiB).toBe((100 + 50 + 25) * 16384 / (1024 * 1024));
    svc.tick();
    expect(spawns).toBe(1);
    watched.close();
    svc.close();
  });

  it("fileOnDisk reads a recording's duration out of its container", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-dur-"));
    try {
      const file = join(dir, "note.wav");
      const made = wavBytes(1000);
      writeFileSync(file, made);
      expect(fileOnDisk(file)).toMatchObject({ path: file, size: made.length, durationMs: 1000 });
      expect(fileOnDisk(join(dir, "no-such.wav"))).toBeNull();
      // S1: audio is known by its own bytes. A file that is not one of the containers is no recording, whatever its name.
      writeFileSync(join(dir, "note.wav"), "%PDF-1.7 made up");
      expect(fileOnDisk(join(dir, "note.wav"))).toBeNull();
    }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });

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
    const made = requestTranscription([], { id: "tx-run", recording: { kind: "upload", id: "a" }, sizeBytes: 12, language: "auto" }, 10, { present: true, maxSeconds: 600 }, "multi");
    if (!made.ok) throw new Error(made.error);
    const running: Transcription = { ...made.value, state: "running", startedAt: 20 };
    const waiting = requestTranscription([], { id: "tx-wait", recording: { kind: "upload", id: "b" }, sizeBytes: 12, language: "auto" }, 11, { present: true, maxSeconds: 600 }, "multi");
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
    files.set("a-swept", { path: "/audio/a-swept.wav", size: 12, durationMs: null });   // sorts before "b": with the clock fixed, FIFO
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

  it("finds each endpoint's own row when two endpoints share an id", async () => {
    const gate = new Gate();
    const { svc } = service(memory(), gate);
    await svc.start();
    await svc.request(body("same", "hang", "auto", "ep-1"));
    expect(await until(() => svc.get("same", { endpointId: "ep-1" })?.state === "running", 2000)).toBe(true);
    const other = await svc.request(body("same", "b", "auto", "ep-2"));
    expect(other.ok && other.value.recording.id).toBe("b");
    expect(svc.get("same", { endpointId: "ep-1" })?.recording.id).toBe("hang");
    expect(svc.get("same", { endpointId: "ep-2" })?.recording.id).toBe("b");
    svc.close();
  });

  it("a finished row another endpoint owns does not become this caller's attempt", async () => {
    files.set("clip", { path: "/audio/clip.wav", size: 100, durationMs: null });
    try {
      const gate = new Gate();
      const { svc } = service(memory(), gate);
      await svc.start();
      const ask = (endpointId: string) => svc.request({
        id: "t1", recording: { kind: "attachment", id: "clip" }, language: "en", caller: { endpointId },
      });
      expect((await ask("ep-1")).ok).toBe(true);
      gate.release("/audio/clip.wav");
      expect(await until(() => svc.get("t1", { endpointId: "ep-1" })?.state === "done", 2000)).toBe(true);
      const clip = files.get("clip");
      if (clip) clip.size = 120;
      const again = await ask("ep-2");
      expect(again.ok && again.value.sizeBytes).toBe(120);
      expect(again.ok && again.value.state).not.toBe("done");
      expect(svc.get("t1", { endpointId: "ep-1" })).toMatchObject({ state: "done", sizeBytes: 100 });
      svc.close();
    } finally {
      files.delete("clip");
    }
  });

  it("a row with no recorded owner answers nobody", async () => {
    const old: Transcription = {
      id: "old", recording: { kind: "attachment", id: "a" }, language: "de", sizeBytes: 12,
      acceptedAt: 1, state: "done", position: null, reason: null, outcome: "done", problem: null,
      text: null, report: null, startedAt: 1, endedAt: 2,
    };
    const gate = new Gate();
    const { svc } = service(memory([old]), gate);
    await svc.start();
    expect(svc.get("old", { endpointId: "ep-1" })).toBeNull();
    expect(svc.cancel("old", { endpointId: "ep-1" })).toEqual({ ok: false, error: "unknown" });
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

  it("scales the timeout with the recording's own duration, capped at the run's cap", async () => {
    const seen: number[] = [];
    const gate = new Gate();
    const { svc } = service(memory(), gate, { timeoutFor: ms => (seen.push(ms), 40) });
    await svc.start();
    await svc.request(body("tx-short", "short"));
    expect(seen).toEqual([10_000]);                    // a 10 s note: 120 s + 6 × 10 s, not 120 s + 6 × the cap
    expect(await until(() => svc.get("tx-short")?.state === "timed_out", 2000)).toBe(true);
    await svc.request(body("tx-over", "over"));
    expect(seen[1]).toBe(600_000);                     // longer than the cap counts as the cap
    expect(await until(() => svc.get("tx-over")?.state === "timed_out", 2000)).toBe(true);
    await svc.request(body("tx-plain", "a"));
    expect(seen[2]).toBe(600_000);                     // a duration the container does not say: the cap, never less
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

  it("a language this engine does not list is refused before anything runs", async () => {
    const gate = new Gate();
    gate.ready = { ...READY, languages: ["de", "en"] };
    const { svc } = service(memory(), gate);
    await svc.start();
    const refused = await svc.request(body("tx-xx", "a", "xx"));
    expect(refused).toEqual({ ok: false, error: "bad_language" });
    expect(gate.calls).toEqual([]);
    const taken = await svc.request(body("tx-de", "a", "de"));
    expect(taken.ok && taken.value.state).toBe("running");
    svc.close();
  });

  it("an upload another endpoint made is not a recording for the caller", async () => {
    files.set("foreign", { path: "/audio/foreign.wav", size: 12, durationMs: null, owner: "ep-2" });
    try {
      const gate = new Gate();
      const { svc } = service(memory(), gate);
      await svc.start();
      const refused = await svc.request(body("tx-f", "foreign", "auto", "ep-1"));
      expect(refused).toEqual({ ok: false, error: "unreadable" });
      expect(gate.calls).toEqual([]);
      const own = await svc.request(body("tx-f", "foreign", "auto", "ep-2"));
      expect(own.ok && own.value.state).toBe("running");
      expect(gate.calls).toEqual(["/audio/foreign.wav"]);
      svc.close();
    } finally {
      files.delete("foreign");
    }
  });

  it("stops taking rows once the queue holds its cap, however many languages they name", async () => {
    const gate = new Gate();
    const { svc } = service(memory(), gate);
    await svc.start();
    for (let i = 0; i < 100; i++) {                       // the same recording under many codes: each its own row
      const made = await svc.request(body(`tx-${i}`, "a", `la-${i}`));
      if (!made.ok) throw new Error(JSON.stringify(made.error));
    }
    expect(gate.calls).toEqual(["/audio/a.wav"]);         // one runs; the rest wait behind it
    const refused = await svc.request(body("tx-over", "a", "la-99x"));
    expect(refused).toEqual({ ok: false, error: "too_many" });
    const again = await svc.request(body("tx-0", "a", "la-0"));   // a row already in flight still comes back
    expect(again.ok && again.value.state).toBe("running");
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
      now: () => 1_700_000_000_000, file: port,
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
