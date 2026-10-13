// Queue, timeout, cancel and restart for one Recording (ADR-0021; design §9). The domain decides the row.
// This starts the Transcriber, one run at a time unless the limit says more, and remembers a run the process
// no longer has as lost. It does not read the audio itself: the caller names the file.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import {
  afterRestart, audioDurationMs, capabilityReady, effectiveMaxSeconds, endTranscription, requestTranscription, scheduleTranscriptions,
  startTranscription, threadsFor, transcriptionTimeoutMs, TRANSCRIPTION_LIMIT_DEFAULT, MAX_RECORDING_SECONDS,
  type QueueGuard, type Recording, type Result, type Transcription, type TranscriptionCapability, type TranscriptionRequestProblem,
  err, ok,
} from "@morndo/domain";
import type { MeTranscription, Transcriber, TranscriberProbe } from "@morndo/protocol";

export type RecordingFile = { path: string; size: number; durationMs: number | null };

export function fileOnDisk(path: string | null | undefined): RecordingFile | null {
  if (!path) return null;
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    return { path, size: st.size, durationMs: durationOnDisk(path, st.size) };
  } catch {
    return null;
  }
}

// §9's timeout scales with the recording's length, and the container's own header says it: the head and the tail
// carry what each one keeps (an m4a's moov may sit at the end, an Ogg's last page too). Whatever the bytes do not
// say stays null — the caller then uses its cap, never a guess.
const DURATION_HEAD = 256 * 1024;
const DURATION_TAIL = 64 * 1024;
function durationOnDisk(path: string, size: number): number | null {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(Math.min(size, DURATION_HEAD));
    readSync(fd, head, 0, head.length, 0);
    if (size <= head.length) return audioDurationMs({ head, size });
    const tail = Buffer.alloc(Math.min(size - head.length, DURATION_TAIL));
    readSync(fd, tail, 0, tail.length, size - tail.length);
    return audioDurationMs({ head, tail, tailAt: size - tail.length, size });
  }
  catch {
    return null;
  }
  finally {
    closeSync(fd);
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
  #active: Transcriber | null;
  #locate: (() => { transcriber: Transcriber | null; unavailable: TranscriberProbe | null } | null) | null;
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
  #closed = false;
  #sweep: ReturnType<typeof setInterval> | null = null;

  constructor(p: {
    store: TranscriptionStore;
    transcriber: Transcriber | null;
    unavailable?: TranscriberProbe | null;
    locate?: () => { transcriber: Transcriber | null; unavailable: TranscriberProbe | null } | null;
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
    tickMs?: number;
  }) {
    this.#store = p.store;
    this.#transcriber = p.transcriber;
    this.#active = p.transcriber;
    this.#locate = p.locate ?? null;
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
    // A row the guard holds (load, memory, guard_unknown) has nothing else waiting on it: a minute's sweep re-checks
    // the queue, as the jobs' own minute does (jobs-service). Unref'd, so an idle service never holds the process.
    const sweepMs = p.tickMs ?? 60_000;
    if (sweepMs > 0) {
      this.#sweep = setInterval(() => this.tick(), sweepMs);
      this.#sweep.unref?.();
    }
  }

  async start(): Promise<void> {
    await this.refresh();
    this.tick();
  }

  // The hub is going down. In-flight runs are aborted with no recorded end, so the next start marks them lost (TX4),
  // and nothing further is launched: no queued row gets a slot after this.
  close(): void {
    this.#closed = true;
    if (this.#sweep) clearInterval(this.#sweep);
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    for (const ac of this.#inflight.values()) ac.abort();
  }

  // The row a caller names by id: the earliest live one (several may share an id in flight; TX2's attempts are told
  // apart by Recording and Language, not id), else the newest ended.
  get(id: string): Transcription | null {
    const matches = this.#rows
      .filter(row => row.id === id)
      .sort((a, b) => a.acceptedAt - b.acceptedAt || (rowKey(a) < rowKey(b) ? -1 : rowKey(a) > rowKey(b) ? 1 : 0));
    return matches.find(row => live(row.state)) ?? matches.at(-1) ?? null;
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

  async request(input: { id: string; recording: Recording; language: string }): Promise<Result<Transcription, TranscriptionRequestProblem | "unreadable">> {
    await this.refresh();
    const file = this.#file(input.recording);
    if (!file) return err("unreadable");
    const decided = requestTranscription(this.#rows, {
      id: input.id, recording: input.recording, language: input.language, sizeBytes: file.size,
    }, this.#now(), this.capability());
    if (!decided.ok) return decided;
    if (!this.#rows.some(row => sameRow(row, decided.value))) this.#save(decided.value);
    this.tick();
    // The row this body made or matched (TX2's in-flight attempt), not whichever live row answers to the id first.
    const made = this.#rows.find(row => sameRow(row, decided.value));
    return ok(made ?? decided.value);
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
    if (this.#closed || !capabilityReady(this.capability())) return;
    // A row whose launch found nothing to run (its file gone) ends failed without ever holding a run, so no #finish
    // frees its slot: the pass is taken again for whoever waits behind it. Each pass starts at least one row or
    // shrinks the queue, so the retry ends.
    for (let again = true; again;) {
      again = false;
      const scheduled = scheduleTranscriptions(this.#rows, this.#limit, this.#guard());
      for (const row of scheduled) {
        const prev = this.#rows.find(item => sameRow(item, row));
        if (!prev || prev.state !== row.state || prev.position !== row.position || prev.reason !== row.reason) this.#save(row);
        if (row.state === "starting" && !this.#launch(this.#rows.find(item => sameRow(item, row)) ?? row)) again = true;
      }
    }
  }

  async #probe(): Promise<TranscriptionCapability> {
    const cached = this.#cache;
    if (cached && this.#now() - cached.at < this.#probeTtlMs) return this.capability();
    let probe: TranscriberProbe;
    if (this.#locate) {
      // Each probe asks again what is on the machine (design §6: the capability follows the probe): a plugin
      // installed while the hub runs turns the feature on, one removed or turned unsafe turns it off.
      const located = this.#locate();
      this.#active = located?.transcriber ?? null;
      if (!located || !located.transcriber) probe = located?.unavailable ?? { ready: false, reason: "missing", detail: "missing" };
      else {
        try { probe = await located.transcriber.probe(); }
        catch { probe = { ready: false, reason: "not_ready", detail: "probe_failed" }; }
      }
    }
    else if (this.#unavailable) probe = this.#unavailable;
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

  // Whether the row holds a run afterwards: true when it started (or already held one), false when it ended without
  // ever running, so the caller can hand its slot to the next row.
  #launch(row: Transcription): boolean {
    const key = rowKey(row);
    if (this.#inflight.has(key) || row.state !== "starting") return true;
    const file = this.#file(row.recording);
    if (!file) {
      const ended = endTranscription(row, { outcome: "failed", at: this.#now(), problem: "unreadable" });
      if (ended.ok) this.#save(ended.value);
      return false;
    }
    const started = startTranscription(row, this.#now());
    const running = started.ok ? started.value : row;
    if (started.ok) this.#save(running);
    const ac = new AbortController();
    this.#inflight.set(key, ac);
    const cap = this.capability();
    const maxSeconds = cap.present ? cap.maxSeconds : this.#maxSeconds;
    // §9: 120 s + 6 × the recording's own duration, never longer than the cap says. A container that does not
    // say its length counts as the cap — the run is not cut short on a guess.
    const durationMs = Math.min(Math.max(file.durationMs ?? maxSeconds * 1000, 0), maxSeconds * 1000);
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      this.#why.set(key, "timed_out");
      ac.abort();
    }, this.#timeoutFor(durationMs));
    this.#timers.add(timer);
    const transcriber = this.#active ?? this.#transcriber;
    if (!transcriber) return true;
    void transcriber.transcribe({
      path: file.path, language: row.language, threads: this.#threads, maxSeconds, signal: ac.signal,
    }).then(result => {
      this.#finish(key, timer, result.ok
        ? { outcome: "done", at: this.#now(), engine: result.value, engineName: this.#engine.name, model: this.#engine.model }
        : { outcome: "failed", at: this.#now(), problem: result.error });
    }, () => {
      // The close() abort has no principal behind it: the run keeps no recorded end, so the next start marks it lost
      // (TX4). A queued row's slot is not handed on either; the next start queues the row again in its order.
      if (this.#closed) {
        clearTimeout(timer);
        this.#timers.delete(timer);
        this.#inflight.delete(key);
        return;
      }
      // A rejection with the signal still live is the host's own failure (no space, a spawn that threw): the run
      // failed, and no reason an earlier attempt on this recording left behind may decide it.
      if (!ac.signal.aborted) {
        this.#finish(key, timer, { outcome: "failed", at: this.#now(), problem: "engine" });
        return;
      }
      const why = this.#why.get(key) ?? "cancelled";
      this.#finish(key, timer, why === "timed_out"
        ? { outcome: "timed_out", at: this.#now() }
        : { outcome: "cancelled", at: this.#now() });
    });
    return true;
  }

  #finish(key: string, timer: ReturnType<typeof setTimeout>, event: Parameters<typeof endTranscription>[1]): void {
    clearTimeout(timer);
    this.#timers.delete(timer);
    this.#inflight.delete(key);
    this.#why.delete(key);
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
