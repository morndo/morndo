// Queue, timeout, cancel and restart for one Recording (ADR-0021; design §9). The domain decides the row.
// This starts the Transcriber, one run at a time unless the limit says more, and remembers a run the process
// no longer has as lost. It does not read the audio itself: the caller names the file.
import { statSync } from "node:fs";
import { availableParallelism } from "node:os";
import {
  afterRestart, capabilityReady, effectiveMaxSeconds, endTranscription, requestTranscription, scheduleTranscriptions,
  startTranscription, threadsFor, transcriptionTimeoutMs, TRANSCRIPTION_LIMIT_DEFAULT, MAX_RECORDING_SECONDS,
  type QueueGuard, type Recording, type RequestProblem, type Result, type Transcription, type TranscriptionCapability,
  err, ok,
} from "@morndo/domain";
import type { MeTranscription, Transcriber, TranscriberProbe } from "@morndo/protocol";

export type RecordingFile = { path: string; size: number };

export function fileOnDisk(path: string | null | undefined): RecordingFile | null {
  if (!path) return null;
  try {
    const st = statSync(path);
    return st.isFile() ? { path, size: st.size } : null;
  } catch {
    return null;
  }
}

export type TranscriptionStore = {
  transcriptions(): Transcription[];
  saveTranscription(row: Transcription): void;
};

const rowKey = (tx: Transcription) => `${tx.recording.kind}:${tx.recording.id}:${tx.language}`;
const sameRow = (a: Transcription, b: Transcription) => a.id === b.id && rowKey(a) === rowKey(b);
const live = (state: Transcription["state"]) => state === "queued" || state === "starting" || state === "running";

export class TranscriptionService {
  #store: TranscriptionStore;
  #transcriber: Transcriber | null;
  #unavailable: TranscriberProbe | null;
  #now: () => number;
  #limit: number;
  #maxSeconds: number;
  #threads: number;
  #guard: () => QueueGuard;
  #file: (recording: Recording) => RecordingFile | null;
  #log: (line: string) => void;
  #probeTtlMs: number;
  #timeoutFor: (durationMs: number) => number;
  #rows: Transcription[];
  #cache: { at: number; probe: TranscriberProbe } | null = null;
  #engine = { name: "", model: "" };
  #logged = "";
  #inflight = new Map<string, AbortController>();
  #why = new Map<string, "timed_out" | "cancelled">();
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #probeChain: Promise<void> = Promise.resolve();

  constructor(p: {
    store: TranscriptionStore;
    transcriber: Transcriber | null;
    unavailable?: TranscriberProbe | null;
    file: (recording: Recording) => RecordingFile | null;
    now?: () => number;
    limit?: number;
    timeoutSec?: number | null;
    maxSeconds?: number;
    threads?: number | null;
    cores?: number;
    guard?: () => QueueGuard;
    log?: (line: string) => void;
    probeTtlMs?: number;
    timeoutFor?: (durationMs: number) => number;
  }) {
    this.#store = p.store;
    this.#transcriber = p.transcriber;
    this.#unavailable = p.unavailable ?? null;
    this.#now = p.now ?? Date.now;
    this.#limit = p.limit ?? TRANSCRIPTION_LIMIT_DEFAULT;
    this.#maxSeconds = p.maxSeconds ?? MAX_RECORDING_SECONDS;
    this.#threads = p.threads ?? threadsFor(p.cores ?? availableParallelism());
    this.#guard = p.guard ?? (() => "off");
    this.#file = p.file;
    this.#log = p.log ?? (() => {});
    this.#probeTtlMs = p.probeTtlMs ?? 60_000;
    const timeoutSec = p.timeoutSec ?? null;
    this.#timeoutFor = p.timeoutFor ?? (durationMs => transcriptionTimeoutMs(durationMs, timeoutSec));
    const loaded = p.store.transcriptions();
    const restarted = afterRestart(loaded, this.#now());
    this.#rows = restarted;
    for (const row of restarted) {
      const prev = loaded.find(item => sameRow(item, row));
      if (!prev || prev.state !== row.state) this.#store.saveTranscription(row);
    }
  }

  async start(): Promise<void> {
    await this.refresh();
    this.tick();
  }

  close(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    for (const ac of this.#inflight.values()) ac.abort();
  }

  get(id: string): Transcription | null {
    const matches = this.#rows.filter(row => row.id === id);
    return matches.find(row => live(row.state)) ?? matches.sort((a, b) => b.acceptedAt - a.acceptedAt)[0] ?? null;
  }

  capability(): TranscriptionCapability {
    const probe = this.#cache?.probe;
    if (!probe || !probe.ready) return { present: false, reason: probe && !probe.ready ? probe.reason : "missing" };
    return { present: true, maxSeconds: effectiveMaxSeconds(this.#maxSeconds, probe.maxSeconds) };
  }

  allowsMicrophone(): boolean {
    return capabilityReady(this.capability());
  }

  me(): MeTranscription {
    const cap = this.capability();
    const probe = this.#cache?.probe;
    if (!cap.present || !probe || !probe.ready) return false;
    const languages = probe.languages === "multi" ? "multi" : [...probe.languages];
    return { engine: probe.engine, model: probe.model, languages, maxSeconds: cap.maxSeconds };
  }

  async refresh(): Promise<TranscriptionCapability> {
    const run = this.#probeChain.then(() => this.#probe());
    this.#probeChain = run.then(() => {}, () => {});
    return run;
  }

  async request(input: { id: string; recording: Recording; language: string }): Promise<Result<Transcription, RequestProblem | "unreadable">> {
    await this.refresh();
    const file = this.#file(input.recording);
    if (!file) return err("unreadable");
    const decided = requestTranscription(this.#rows, {
      id: input.id, recording: input.recording, language: input.language, sizeBytes: file.size,
    }, this.#now(), this.capability());
    if (!decided.ok) return decided;
    if (!this.#rows.some(row => sameRow(row, decided.value))) this.#save(decided.value);
    this.tick();
    return ok(this.get(decided.value.id) ?? decided.value);
  }

  cancel(id: string): Result<Transcription, "unknown"> {
    const row = this.get(id);
    if (!row) return err("unknown");
    if (!live(row.state)) return ok(row);
    const key = rowKey(row);
    this.#why.set(key, "cancelled");
    const ended = endTranscription(row, { outcome: "cancelled", at: this.#now() });
    if (!ended.ok) return ok(row);
    this.#save(ended.value);
    this.#inflight.get(key)?.abort();
    this.tick();
    return ok(ended.value);
  }

  tick(): void {
    if (!capabilityReady(this.capability())) return;
    const scheduled = scheduleTranscriptions(this.#rows, this.#limit, this.#guard());
    for (const row of scheduled) {
      const prev = this.#rows.find(item => sameRow(item, row));
      if (!prev || prev.state !== row.state || prev.position !== row.position || prev.reason !== row.reason) this.#save(row);
      if (row.state === "starting") this.#launch(this.#rows.find(item => sameRow(item, row)) ?? row);
    }
  }

  async #probe(): Promise<TranscriptionCapability> {
    const cached = this.#cache;
    if (cached && this.#now() - cached.at < this.#probeTtlMs) return this.capability();
    let probe: TranscriberProbe;
    if (this.#unavailable) probe = this.#unavailable;
    else if (!this.#transcriber) probe = { ready: false, reason: "missing", detail: "missing" };
    else {
      try { probe = await this.#transcriber.probe(); }
      catch { probe = { ready: false, reason: "not_ready", detail: "probe_failed" }; }
    }
    this.#cache = { at: this.#now(), probe };
    this.#note(probe);
    return this.capability();
  }

  #note(probe: TranscriberProbe): void {
    const line = probe.ready ? `transcription: on (${probe.engine} ${probe.model})` : `transcription: off (${probe.reason})`;
    if (line !== this.#logged) {
      this.#logged = line;
      this.#log(line);
    }
    if (probe.ready) {
      this.#engine = { name: probe.engine, model: probe.model };
      return;
    }
    for (const row of [...this.#rows]) {
      if (row.state !== "queued") continue;
      const ended = endTranscription(row, { outcome: "failed", at: this.#now(), problem: "not_ready" });
      if (ended.ok) this.#save(ended.value);
    }
  }

  #launch(row: Transcription): void {
    const key = rowKey(row);
    if (this.#inflight.has(key) || row.state !== "starting") return;
    const file = this.#file(row.recording);
    if (!file) {
      const ended = endTranscription(row, { outcome: "failed", at: this.#now(), problem: "unreadable" });
      if (ended.ok) this.#save(ended.value);
      return;
    }
    const started = startTranscription(row, this.#now());
    const running = started.ok ? started.value : row;
    if (started.ok) this.#save(running);
    const ac = new AbortController();
    this.#inflight.set(key, ac);
    const cap = this.capability();
    const maxSeconds = cap.present ? cap.maxSeconds : this.#maxSeconds;
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      this.#why.set(key, "timed_out");
      ac.abort();
    }, this.#timeoutFor(maxSeconds * 1000));
    this.#timers.add(timer);
    const transcriber = this.#transcriber;
    if (!transcriber) return;
    void transcriber.transcribe({
      path: file.path, language: row.language, threads: this.#threads, maxSeconds, signal: ac.signal,
    }).then(result => {
      this.#finish(key, timer, result.ok
        ? { outcome: "done", at: this.#now(), engine: result.value, engineName: this.#engine.name, model: this.#engine.model }
        : { outcome: "failed", at: this.#now(), problem: result.error });
    }, () => {
      const why = this.#why.get(key) ?? "cancelled";
      this.#finish(key, timer, why === "timed_out"
        ? { outcome: "timed_out", at: this.#now() }
        : { outcome: "cancelled", at: this.#now() });
    });
  }

  #finish(key: string, timer: ReturnType<typeof setTimeout>, event: Parameters<typeof endTranscription>[1]): void {
    clearTimeout(timer);
    this.#timers.delete(timer);
    this.#inflight.delete(key);
    const current = this.#rows.find(row => rowKey(row) === key && live(row.state));
    if (current) {
      const cap = this.capability();
      const ended = endTranscription(current, event, cap.present ? cap.maxSeconds : this.#maxSeconds);
      if (ended.ok && ended.value !== current) this.#save(ended.value);
    }
    this.tick();
  }

  #save(row: Transcription): void {
    const i = this.#rows.findIndex(item => sameRow(item, row));
    if (i < 0) this.#rows.push(row);
    else this.#rows[i] = row;
    this.#store.saveTranscription(row);
  }
}
