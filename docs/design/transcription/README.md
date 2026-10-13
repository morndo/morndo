# Transcription: voice messages and audio files become text on the user's own machine, through an optional plugin (design v1, 2026-10-11)

**Phase: design only.** This document and [ADR-0021](../../adr/0021-optional-transcription-plugin.md). No product code yet.

The principal speaks into the phone, and a lane receives text. An audio file an agent sends can be read as well as played. All of it happens on a machine the user runs. None of it is installed unless the user asks for it.

How it fits what is already decided:

| Already decided | What transcription uses |
|---|---|
| ADR-0001 | A pure domain context. The engine is an adapter at the edge. |
| ADR-0006, ADR-0011, S1–S3 | Uploads, file chips, the attachment note `[The owner attached a file: <path>]`, and the phone composer. |
| ADR-0013 | An external CLI behind a probe. Missing or too old, the feature is hidden. |
| ADR-0017, J2, J4, J5 | Class limit, FIFO with a position, the optional guard, terminal-once, `lost` after a restart. |
| ADR-0018 | An optional piece the hub reaches only as a child process, enabled by configuration. |
| ADR-0019 (proposed) | Signed per-platform archives and `morndo doctor`. The plugin becomes an optional artifact there. |
| AGENTS.md | Made-up fixtures. No QA evidence in the repo. |

## 1. What we looked at first

**In the code (on `main`, 2026-10-11):**

| Fact | Where |
|---|---|
| Uploads accept images, PDF and text. An audio extension is `not_allowed` and the hub answers 415. | `packages/domain/src/steering.ts` (`screenNamedUpload`, `UPLOAD_ACCEPT`), `apps/hub/src/adapters/http.ts` |
| The upload route reads at most 10 MiB and stores the file 0600 in the inbox (`MORNDO_INBOX`, default under `~/.cache/morndo/inbox`). | `apps/hub/src/adapters/uploads.ts`, `apps/hub/src/config.ts` |
| A Command's text reaches a pane through `pane.send`, at most `maxSendText` = 8000 characters. | `packages/protocol/src/fleet.ts` |
| The hub sends `Permissions-Policy: camera=(), microphone=(), …`. Recording is blocked. | `apps/hub/src/adapters/http.ts` |
| Files from agents are typed by extension. `.mp3 .ogg .oga .wav .m4a` are `audio`. The desktop plays them; the phone shows a chip. | `apps/hub/src/adapters/file-kinds.ts`, `apps/web/src/lib/desktop/Attachments.svelte`, `apps/web/src/lib/phone/chat/Conversation.svelte` |
| No plugin loader, no `optionalDependencies`, no `import()` of optional code. Optional features are a null port, a 404 `<x>_off`, and a boolean in `/api/me`. | `apps/hub/src/adapters/http.ts` (`/api/me`: `desktop`, `engines`, `connections`) |
| Jobs run on nodes, started by lanes. The hub mirrors them and starts none. | `docs/design/background-jobs/README.md` §2–§3, `apps/hub/src/application/jobs-service.ts` |
| Workspaces are `packages/*` and `apps/*`. | root `package.json` |
| "Transcript" already means a worker's session log (`TranscriptSource`). | `apps/hub/src/application/ports.ts`, `docs/domain.md` (Observation) |

**The engines, checked live:**

| Engine | Licence (code / weights) | Shape | Activity |
|---|---|---|---|
| whisper.cpp v1.9.5 [T1] | MIT / MIT (OpenAI Whisper [T3]) | One C++ binary and one model file. Built-in VAD. Writes txt, srt or json. `whisper-cli` "currently runs only with 16-bit WAV files", so ffmpeg converts opus and AAC first. | Released 2026-10-06; commits daily |
| faster-whisper 1.2.1 on CTranslate2 4.8.2 [T4] | MIT / MIT | A Python package. Decodes with PyAV, so it needs no system ffmpeg. | Last release 2025-10-31 |
| sherpa-onnx 1.13.8 with Parakeet TDT 0.6B v3 [T5] | Apache-2.0 / CC-BY-4.0 | ONNX runtime. 25 European languages. | Released 2026-09-10 |

**Measured on 2026-10-11** [M] (8-core desktop CPU with AVX2, WSL2, other work running, 8 threads, whisper.cpp v1.9.5):

| Model (ggml) | Size | English 120 s (public-domain reading) | German 40 s (synthetic voice, made-up text) |
|---|---|---|---|
| `base` | 142 MiB | RTF 0.09, WER 9.2% | RTF 0.16, WER 17.7% |
| `small` | 466 MiB | RTF 0.30, WER 6.1% | RTF 0.35, WER 16.3% |
| `large-v3-turbo-q5_0` | 547 MiB | RTF 0.96, WER 3.5% | RTF 0.87, WER 11.3% |

RTF is wall time over audio length. The same German text as ogg/opus gave the same WER with turbo, so the format does not change the result. Most errors in German speech fall on English loanwords ("pull request", "review"). Greedy decoding saved only about 10% with turbo: the encoder dominates. A real human German recording was not measured. That re-test is listed in §14.

## 2. Goals and non-goals

**Goals:**
1. A default install is unchanged. It has the same dependencies, the same upload rules and the microphone blocked, and none of the new routes answer.
2. One opt-in command installs an engine. Only checksummed bytes run.
3. Speech becomes text on the hub's machine, and the principal reviews it before an agent reads it.
4. The engine can be replaced without hub changes.
5. CPU use is bounded and visible, using the rules people already know from Jobs.

**Non-goals (v1):**
- Live captions while speaking.
- Speaker labels.
- Translation.
- Text-to-speech.
- Transcribing on another node.
- A cloud speech API.
- A plugin store.

## 3. The model

### 3.1 One new context, and why

**Transcription** is its own bounded context in `packages/domain/src/transcription.ts`.
- **Why not part of Steering:** Steering decides what a Command may carry. Transcription has its own lifecycle (queued, running, outcome), its own failure modes, and recordings that are not Uploads (an agent's audio Attachment).
- **Why not Jobs:** a Job is a lane's command with a lane notice (J3). A Transcription is the principal's request whose result is data on a recording.
- **Relationships:**
  - *Jobs supplies Transcription* with the queue decision. This is a shared rule, not shared rows: PR 1 extracts `schedule()`'s class/FIFO/guard logic into one pure function both call.
  - *Transcription supplies Steering*: a done Transcription's Text can become a Command's text, and only the principal's send makes it one (AC7).

### 3.2 Ubiquitous language

| Term | Means | Is not |
|---|---|---|
| Recording | An audio file the principal uploaded or recorded (an audio Upload), or an audio Attachment an agent sent. Known by its upload id or its hub file id. | A Transcript (Observation's word for a session log). |
| Transcription | One attempt to turn one Recording into Text, with a state, a queue position and reason, an outcome, and, when done, its Text. | A Job. Transcription keeps no command line and no lane. |
| Text | What the engine heard: the language, segments with start and end times, the joined text, the engine and model that produced it, and whether the principal edited it. | A Command, until the principal sends it. |
| Language choice | `auto`, or a language code the engine lists. | A translation target. |
| Transcriber | The port: probe the engine, transcribe one file. | The engine itself. |
| Capability | Whether a ready Transcriber is there now: present, protocol 1, a model, and a decoder. | A setting the user flips; it follows the probe. |

### 3.3 Invariants

| # | Invariant |
|---|---|
| TX1 | A Transcription runs on the hub's machine, from a file already there. No adapter in this design sends audio or text off that machine. |
| TX2 | A Recording has at most one Transcription in flight. A repeat request for the same Recording and Language choice returns it. |
| TX3 | A Transcription becomes terminal once (`done`, `failed`, `timed_out`, `cancelled`, `lost`). It is never re-run on its own. The principal may ask again, which makes a new Transcription. |
| TX4 | A Transcription whose run is gone with no recorded end (a hub restart) becomes `lost`. The row stays. |
| TX5 | At most `limit` Transcriptions run at once (default 1). Others wait in the order accepted, each with a visible position. The guard delays a start and never stops a run (as J5). |
| TX6 | A Recording is at most 10 MiB and at most `maxSeconds` long (default 600). A longer one is `failed: too_long` before decoding the whole file where the engine can tell. Text is at most 64 KiB. |
| TX7 | Text never replaces its Recording. An edit keeps the engine's text and marks the result `edited`. |
| TX8 | Text grants nothing. It becomes part of a Command only when the principal sends it (AC7). Text from an agent's Recording is that agent's content and is never offered as the principal's Command. |
| TX9 | With no Capability, nothing in this context runs or is offered. Audio Uploads are refused as on `main`, and the microphone stays blocked. |

**S1 change, in Steering:** an audio Upload (`.ogg .oga .opus .webm .m4a .mp3 .wav`) is allowed only while the Capability is present. A Safari recording is named `.m4a`.
- Its bytes must match its container:
  - `OggS` for Ogg;
  - the EBML magic `1A 45 DF A3` for WebM;
  - `ftyp` at offset 4 for MP4/M4A;
  - `ID3` or an MPEG frame sync for MP3;
  - `RIFF…WAVE` for WAV.
- It is at most 10 MiB.
- `screenNamedUpload` takes the Capability as an argument, so the rule stays pure.

### 3.4 States

```
queued(position, reason) ─▶ starting ─▶ running ─▶ done | failed(problem) | timed_out | cancelled
        │                                   └─────▶ lost      (hub restarted mid-run)
        └──▶ cancelled                                           (never ran)
```

`problem` is one of `unreadable` (not audio, or decoding failed), `too_long`, `not_ready` (the plugin lost its model or ffmpeg since the probe), `bad_output` (the plugin broke protocol 1), and `engine` (any other non-zero exit). The queue `reason` is `class`, `load`, `memory` or `guard_unknown`, as for Jobs.

### 3.5 Events

`TranscriptionRequested`, `TranscriptionStarted`, `TranscriptionEnded` (with outcome), `TextEdited`, and `CapabilityChanged` (present or absent, with a reason: `missing`, `not_ready`, `protocol`). None carries audio. Only `TranscriptionEnded` carries text, and it is never logged.

## 4. Layers, ports and adapters

```
packages/domain/src/transcription.ts         pure: types, TX1–TX9, sniffAudio, state moves, queue via the shared rule
packages/protocol/src/transcription.ts       zod: plugin protocol 1 (probe, run) and the web API bodies
apps/hub/src/application/ports.ts            + Transcriber
apps/hub/src/application/transcription-service.ts   queue, timeouts, cancel, restart -> lost, Capability cache
apps/hub/src/adapters/transcriber-process.ts the plugin host: spawn, parse, kill
apps/hub/src/adapters/store.ts               + migration: transcriptions table
apps/hub/test/fixtures/fake-transcribe.mjs   a protocol-1 plugin made of fixed answers, for tests
plugins/transcribe-whisper-cpp/              NOT a workspace: its own package.json, lockfile, LICENSES/, CI job
```

**The port** (named for what it does, as the repo's other ports are):

```ts
export type TranscriberProbe =
  | { ready: true; engine: string; engineVersion: string; model: string; languages: "multi" | string[]; maxSeconds: number }
  | { ready: false; reason: "missing" | "not_ready" | "protocol"; detail: string };

export type Transcriber = {
  probe(): Promise<TranscriberProbe>;
  transcribe(input: {
    path: string; language: LanguageChoice; threads: number; maxSeconds: number; signal: AbortSignal;
  }): Promise<Result<EngineText, TranscribeProblem>>;
};
```

- `EngineText` holds `language`, `durationMs` and `segments` (`startMs`, `endMs`, `text`); the domain joins and caps the text.
- `TranscribeProblem` is the `problem` list in §3.4.
- The hub's composition root wires `transcription: null` when nothing is found. The routes then return 404 `transcription_off`, as `engines_off` does today.

**Adapters:**

| Adapter | Where | Ships in the default install |
|---|---|---|
| `ProcessTranscriber`: runs a protocol-1 executable | `apps/hub/src/adapters/transcriber-process.ts` | Yes. It is about 150 lines, has no dependencies, and is idle without a plugin. |
| `MemoryTranscriber`: scripted answers, a manual clock | `apps/hub/src/application/fakes.ts` (tests) | No (test code). |
| whisper.cpp engine, `morndo-transcribe` | `plugins/transcribe-whisper-cpp/` | **No.** It is a separate install. |
| Later: faster-whisper, sherpa-onnx with Parakeet | other `plugins/transcribe-*` | No |

**Architecture tests** (each with a negative control):
- The domain module imports only its siblings.
- Nothing under `apps/` or `packages/` imports from `plugins/`.
- The root `package-lock.json` names no package from `plugins/`.
- No engine or model name appears in domain or application code; only adapters and the plugin know "whisper".

## 5. Plugin protocol 1

The plugin is an executable. The hub calls it with an argument vector and never a shell [T12].

**Probe** (5 s timeout; cached 60 s):

```
morndo-transcribe probe --json
```
```json
{ "protocol": 1, "ready": true, "engine": "whisper.cpp", "engineVersion": "1.9.5",
  "model": "large-v3-turbo-q5_0", "languages": "multi", "maxSeconds": 600, "missing": [] }
```

When `ready` is false, `missing` names what is absent (`"model"`, `"ffmpeg"`). The hub hides the feature, and `doctor` prints the list.

**Run:**

```
morndo-transcribe run --input <absolute path> --language auto|<code> --threads <n> --max-seconds <n> --json
```
```json
{ "protocol": 1, "language": "de", "durationMs": 40040,
  "segments": [ { "startMs": 0, "endMs": 5200, "text": "Kurze Notiz zum Projekt ..." } ] }
```

**Exit codes:**

| Code | Meaning | Problem |
|---|---|---|
| 0 | JSON on stdout | — |
| 2 | Usage | `engine` |
| 3 | Not audio, or decoding failed | `unreadable` |
| 4 | Longer than `--max-seconds` | `too_long` |
| 5 | Model or decoder missing | `not_ready` |
| other | Anything else | `engine` |

**What the host enforces:**
- **Environment:** only `PATH`, `HOME`, `LANG` and `TMPDIR`. `TMPDIR` is a fresh directory the host removes afterwards, and it is also the working directory.
- **Output:** stdout is capped at 1 MiB and stderr at 4 KiB. Stderr is redacted, never stored with the text, and shown only as `detail`.
- **Validation:** the JSON is validated with the protocol schema. A wrong `protocol`, or any parse failure, gives `bad_output`.
- **Priority:** right after spawn, the host calls `os.setPriority(pid, PRIORITY_BELOW_NORMAL)` [T9].
- **Timeout and cancel:** `AbortSignal` sends `SIGTERM`, then `SIGKILL` after 10 s, the same escalation as `job.cancel`.

**What the whisper.cpp plugin does inside `run`:**
1. `ffmpeg -nostdin -i <input> -vn -ar 16000 -ac 1 -c:a pcm_s16le <tmp>/in.wav`.
2. Checks the duration against `--max-seconds`.
3. `whisper-cli -m <model> -f <tmp>/in.wav -l <language> -t <threads> -np -oj -of <tmp>/out`.
4. Maps whisper.cpp's JSON (`transcription[].offsets`, `.text`, `result.language`) to protocol 1.

The plugin makes no network call while running. Its CI step runs it with networking disabled (§13).

## 6. Discovery and degradation

**Where the hub looks:**
1. `MORNDO_TRANSCRIBER`, an absolute path, when set.
2. Otherwise `<MORNDO_HOME>/plugins/transcribe/bin/morndo-transcribe`. `MORNDO_HOME` defaults to `~/.local/share/morndo`.
3. Nothing else. There is no `PATH` search.

**The file must be:**
- a regular file or a symlink to one;
- executable;
- owned by the hub's user;
- not group- or world-writable.

Otherwise the result is `{ ready: false, reason: "not_ready", detail: "unsafe_permissions" }`.

**When the hub probes:**
- at start;
- then lazily, when `/api/me` or a transcription route is served and the cached result is older than 60 s;
- in parallel with nothing else: one probe at a time.

**What the principal sees with no plugin, or a plugin that isn't ready:**

| Surface | Without a ready plugin | With one |
|---|---|---|
| `/api/me` | `transcription: false` | `transcription: { engine, model, languages, maxSeconds }` |
| `POST /api/transcriptions`, `GET /api/transcriptions/:id`, `POST …/:id/cancel` | 404 `transcription_off` | Served |
| `/api/uploads` with an audio file | 415 `not_allowed`, as on `main` | Accepted under the S1 change |
| `Permissions-Policy` | `microphone=()` | `microphone=(self)` [T8] |
| Phone and desktop composer | No microphone, and the file picker offers no audio | Microphone button, and the picker offers audio |
| An agent's audio Attachment | Desktop player, phone chip, as today | Plus "Transcribe" |
| Hub log | One line at start: `transcription: off (missing)` | One line on each change |

When the plugin is removed while the hub runs:
- the next probe turns the feature off;
- queued Transcriptions end `failed: not_ready`;
- a running one ends with whatever its process gives;
- texts already made stay readable.

## 7. Opting in: install and remove

**v1, from a checkout** (until ADR-0019's installer exists):

```
npm run plugin:transcribe -- --model small            # or turbo, base
```

The script lives in `plugins/transcribe-whisper-cpp/scripts/install.ts` and is run by the same Node. It:
1. Checks for `cmake`, a C++ compiler and `ffmpeg`, and stops with the exact package names when one is missing (Ubuntu `ffmpeg`, Homebrew `ffmpeg` [T11]).
2. Clones whisper.cpp at the tag pinned in `plugin.json` (v1.9.5 today) and checks the commit id against the pin. It builds `whisper-cli` statically (`-DBUILD_SHARED_LIBS=OFF`). On Apple silicon, inference runs on the GPU through Metal [T1].
3. Downloads the chosen model from `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-<model>.bin` and verifies its sha256 against `plugin.json`. A mismatch deletes the file and stops. The pins come from the Hugging Face LFS pointers and the SHA1 list in whisper.cpp's `models/README.md` [T2].
4. Writes `<MORNDO_HOME>/plugins/transcribe/`:
   - `plugin.json`: name, version, protocol, engine pin, model and sha256;
   - `bin/morndo-transcribe` and `bin/whisper-cli`;
   - `models/`;
   - `LICENSES/` with whisper.cpp's MIT licence and the Whisper weights' MIT notice.
5. Runs `probe` and prints whether it is ready, or what is missing.

The pinned models are:

| Model id | File | Bytes | sha256 |
|---|---|---|---|
| `base` | `ggml-base.bin` | 147951465 | `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe` |
| `small` | `ggml-small.bin` | 487601967 | `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b` |
| `turbo` | `ggml-large-v3-turbo-q5_0.bin` | 574041195 | `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2` |

The installer suggests `small` on machines with fewer than 4 cores or less than 4 GiB of free memory, and `turbo` otherwise (choice 1).

**With ADR-0019:**
- The plugin is an optional artifact per platform (`linux-x64`, `linux-arm64`, `darwin-arm64`) in the same signed release manifest. The manifest carries the digest; the archive is downloaded only on `morndo plugin add transcribe [--model …]`.
- The model download and its sha256 check are the same as in v1.
- `morndo plugin list` shows each plugin and its probe. `morndo doctor` re-verifies the files against `plugin.json`.
- `morndo update` updates an installed plugin with its release and leaves an absent one absent.

**Remove:**
- `morndo plugin remove transcribe` deletes the directory. From a checkout, `rm -r <MORNDO_HOME>/plugins/transcribe` does the same.
- The feature turns off within 60 s.
- ffmpeg stays, because it is the system's.

## 8. Privacy

- **Where the audio is:** in the hub's inbox (0600, 24-hour upload TTL, as every Upload), or in the hub's file copies for an agent's Attachment. Transcription reads it from there and copies it nowhere else. The 16 kHz WAV lives in the run's temporary directory and is deleted when the run ends, whatever the outcome.
- **Where the text is:** in the hub's database, in the `transcriptions` row.
  - Text for an Upload is deleted with that Upload when it expires, unless a Command carried it.
  - Text for an Attachment lives as long as the hub's copy of that file.
- **Logs and events:** never the text, never the audio path in a fleet event, never stderr unredacted. Metrics are counts and durations only.
- **Network:** none at run time (TX1, §13 proves it). Install-time downloads go to the project's release host and to the model's Hugging Face repository, and nowhere else.
- **Microphone:** blocked unless the Capability is present (§6). The browser asks for permission the first time anyway [T7], and only on a secure origin, which passkeys (ADR-0004) already need.

## 9. CPU and limits

Hub config, in the same shape as a Job class:

```json
{ "transcription": { "limit": 1, "timeoutSec": null, "maxSeconds": 600, "threads": null,
                     "guard": { "load1": 6, "memAvailableMiB": 1024 } } }
```

- **`limit`:** 1 by default. One run at a time keeps a laptop usable.
- **`threads`:** null means `min(8, floor(cores / 2))`, which leaves half the machine to the agents.
- **`timeoutSec`:** null means `120 + 6 × duration`. That is about 5× the slowest RTF measured (§1); a small VPS should use the `small` model.
- **`maxSeconds`:** 600 by default. The probe can lower it, but this setting cannot raise it past the plugin's value.
- **`guard`:** absent by default, exactly as `jobs.guard`. When set, it delays starts and never stops a run.

**Queue:**
- The queue decision is the function shared with Jobs: one class, FIFO, position, reason.
- Cancel while queued gives `cancelled` without running. Cancel while running kills the process group and gives `cancelled`.
- A hub restart turns every `running` row into `lost` (TX4), and `queued` rows queue again in their order.

## 10. UI

**Phone composer** (`phone/chat/Conversation.svelte`), only when `me.transcription` is set:
1. **Recording.** A microphone button sits beside the paperclip. Pressing it starts `getUserMedia({ audio: true })` and a `MediaRecorder` [T6, T7].
   - The recorder uses the first type `MediaRecorder.isTypeSupported` accepts: `audio/webm;codecs=opus` first, then `audio/mp4`.
   - Recording shows a timer and stops at `maxSeconds`. The principal can stop or discard it.
2. **Upload.** The recording uploads as an audio Upload, and a chip appears: `Voice 0:23 · transcribing…`. While it waits it shows `· 2nd in line`.
3. **Text.** When the Transcription is `done`, its Text is put into the message field, after whatever was already typed. The text can be edited, and the chip shows the detected language and the model.
4. **Sending.** Send is enabled only after that, or after the principal picks **Send audio only**. If the run failed, the chip says why in words ("couldn't read the audio", "longer than 10 minutes", "transcriber not ready") and offers **Try again** and **Remove**.
5. **The Command.** It carries the field's text and then the audio's note in today's form (S3 order).
   - If the text plus the notes would pass `maxSendText`, the text goes into a `.md` Upload. The Command then says `[The owner attached a file: …voice-<id>.md]` before the audio's note.

**A sent voice message**, in the message list:
- an audio player with `preload="none"`, as on the desktop;
- the text under it, collapsed after three lines (**Show text**);
- an `edited` mark when TX7 applies.

**An agent's audio Attachment:** a **Transcribe** button. The text appears under the player, labelled with the agent as its author and with the model. It is never copied into the composer (TX8).

**Desktop:** the same behaviour in `desktop/Attachments.svelte` and its composer.

**Telegram and other chat bots:** out of v1. The application service's `transcribe(recording)` is the entry point a chat-bot adapter can call later for a voice note it receives.

## 11. A general plugin mechanism: not now

**Recommendation: a convention now, a mechanism later.**

What this design writes down, which a second plugin (OCR, speech output) would reuse unchanged:
1. A directory `<MORNDO_HOME>/plugins/<name>/` holding `plugin.json`, `bin/`, `LICENSES/` and the plugin's data.
2. One executable that answers `probe --json` with `protocol` and `ready`, and does its work as a separate process with JSON on stdout.
3. One port in the hub and one process adapter for it. The adapter stays generic enough to be shared later.
4. `/api/me` reports `<name>: false | {…}`, and the routes answer 404 `<name>_off`.
5. Install through the release manifest (ADR-0019) as an optional artifact, with sha256 for every downloaded file.

What waits for the second plugin:
- a registry;
- a generic `morndo plugin` beyond `add|remove|list`;
- permissions per plugin;
- a store or index;
- hooks into the web app.

Building those now would mean designing them around one example.

## 12. Choices for the owner

Defaults first. None blocks the first three PRs.

| # | Decision | Recommended default |
|---|---|---|
| 1 | Default model when installing | **`turbo`** (large-v3-turbo q5_0, 547 MiB) on 4+ cores with 4+ GiB free: the best German measured. **`small`** below that. `--model` overrides. |
| 2 | Review before sending | **Review:** the text fills the composer and the principal sends it. An "auto-send voice notes" setting can come later. |
| 3 | Where it runs | **The hub's machine only** in v1. Running it on an office node that advertises the plugin is a later typed fleet operation. |

## 13. Test plan

Isolated resources only: a temporary `MORNDO_HOME`, a temporary inbox, random ports, never a running hub.

| Claim | Proof | Negative control |
|---|---|---|
| A default install is unchanged | With no plugin: `/api/me` has `transcription: false`; the three routes are 404 `transcription_off`; an `.ogg` upload is 415; `Permissions-Policy` contains `microphone=()`; the composer renders no microphone (chromium project). | A build that forgets the gate exposes the microphone, and the test must fail. |
| Not installed by default | The root `package-lock.json` has no `plugins/` package. `npm ci` at the root leaves no `whisper` file in `node_modules`. The architecture test finds no import from `plugins/`. | A fixture lockfile that names the plugin fails the check. |
| Port contract | One suite, `transcriberContract(make)`, runs against `MemoryTranscriber`, against `ProcessTranscriber` with `fake-transcribe.mjs`, and against the real plugin. It covers a probe shape, a done run with segments, `unreadable`, `too_long`, `not_ready`, an abort mid-run, and a timeout that kills the process group. | A fake that ignores the abort signal must fail the abort case. |
| The process host is strict | The fixture plugin prints bad JSON, `protocol: 2`, 2 MiB of output, or a token on stderr. The host returns `bad_output` for each, and the stored detail is redacted. | A host that trusts `protocol` fails. |
| Discovery is narrow | A plugin on `PATH` alone is not found. A group-writable plugin is `not_ready: unsafe_permissions`. `MORNDO_TRANSCRIBER` wins. | — |
| Queue and limits | Limit 1: a second request is `queued` at position 1 and starts when the first ends. Cancel while queued never spawns. A hub restart mid-run gives `lost` once. The guard over the line keeps it queued. | A scheduler that starts the second run while the first runs fails. |
| Idempotence and caps | The same Recording and language twice gives one Transcription (TX2). A 64 KiB+ text is cut with a marker. A 601-second recording is `too_long`. | — |
| Send cap | Text that would pass 8000 characters goes as a `.md` Upload, and the Command fits `maxSendText`. | A Command over the cap is refused by `pane.send`'s schema, and the test must see the `.md` path instead. |
| Real engine | When the plugin is installed: a short made-up English clip and a made-up German clip, both self-generated, contain their key words, and the detected language is right. Otherwise `describe.skipIf(!plugin.ready)` prints why. | — |
| No network at run time | CI runs `unshare -rn morndo-transcribe run …` on a fixture clip, so the step has no network, and it must pass. | The same step with a plugin build that fetches a URL fails. |
| End to end | `e2e/transcription.e2e.ts`, with the fixture plugin in CI and the real one when present: record (a fake media stream), see the text, edit it, send, and read the Command in an isolated lane pane. | — |

**CI:**
- `ci.yml` runs every test above with the fixture plugin; the real-engine cases print SKIP.
- A new workflow, `transcription-plugin.yml`, runs on changes under `plugins/transcribe-*` or `apps/hub/src/**/transcri*`, and weekly. It:
  - installs `ffmpeg` and `cmake`;
  - builds the pinned whisper.cpp, cached by tag;
  - downloads `base`, cached by sha256;
  - runs the contract suite, the no-network step and the end-to-end script against the real plugin.

**Manual QA**, notes outside the repo (AGENTS.md):
1. On a real phone, record a German and an English voice note, edit a misheard word, and send.
2. Read the Command in the lane.
3. Transcribe an agent's `.ogg`.
4. Remove the plugin and confirm the microphone disappears within a minute.
5. Re-test German with a real human voice. The measurement in §1 used a synthetic voice.

## 14. Out of scope

| Not in this design | Why |
|---|---|
| A cloud speech API | TX1. It would need its own ADR and explicit opt-in. |
| Transcribing on a fleet node | A later typed operation for a node whose `hello.caps` lists the plugin. The audio would travel over the user's own fleet the way `file.put` stages Uploads today. |
| Streaming or live captions | Voice notes are short. Whole-file runs keep the protocol to one request and one answer. |
| Speaker labels, translation, summaries | Separate features. An agent can summarise text it receives. |
| A bundled ffmpeg | §7 and ADR-0021. |
| Windows-native hubs | Not a target of the releases (ADR-0019). |

## 15. Build plan

Each step is one PR, green on its own. No step installs anything on a live machine.

| Step | PR | Done when |
|---|---|---|
| 1 | **Domain.** `transcription.ts` (TX1–TX9, states, `sniffAudio`, caps); the S1 change behind a Capability argument; the queue decision extracted from `jobs.ts` into a shared pure function; `docs/domain.md` gets the context, invariants and context-map lines. | Domain tests and negative controls are green. All existing job tests pass unchanged. The architecture tests pass. |
| 2 | **Protocol and fixture.** `packages/protocol/src/transcription.ts` (protocol 1, API bodies), `fake-transcribe.mjs`, and the contract suite against `MemoryTranscriber`. | The schema tests and contract suite pass on the fake. |
| 3 | **Hub.** `Transcriber` port, `ProcessTranscriber`, `TranscriptionService` (queue, timeout, cancel, `lost`), store migration, routes, `/api/me`, the audio gate on `/api/uploads`, and the `Permissions-Policy` switch. | The contract suite passes on the process host. The "default install unchanged" row passes. Restart gives `lost`. The send-cap row passes. |
| 4 | **Plugin package.** `plugins/transcribe-whisper-cpp` (`morndo-transcribe`, `plugin.json` pins, install script, `LICENSES/`), the `plugin:transcribe` script, and `transcription-plugin.yml`. | The CI job is green with the real `base` model, including the no-network step. The root lockfile check still passes. A manual install from a clean checkout reaches `ready: true`. |
| 5 | **Web.** Microphone, chips, text into the composer, "Send audio only", the player and text in messages, "Transcribe" on an agent's audio, desktop parity. | Chromium tests and `e2e/transcription.e2e.ts` pass. Manual QA steps 1–4 are done. |
| 6 | **Installer** (after ADR-0019's installer lands). The plugin as an optional signed artifact, `morndo plugin add|remove|list`, and `doctor` lines. | A fresh release install without the plugin passes the "unchanged" row. `plugin add` then `probe` is ready, `plugin remove` turns it off, and a tampered model file fails `doctor`. |

Step 3 is the first a developer can use with the fixture. Step 4 is the first with real speech. Step 5 is the first the principal can use.

## 16. Sources

Checked 2026-10-11.

- **[T1]** whisper.cpp: README (build, `whisper-cli`, 16-bit WAV input, `WHISPER_COMMON_FFMPEG`, VAD) and releases. Latest release v1.9.5, published 2026-10-06. MIT. https://github.com/ggml-org/whisper.cpp
- **[T2]** whisper.cpp `models/README.md` at v1.9.5: model list, sizes, SHA1, "Models are multilingual unless the model name includes `.en`". Hugging Face `ggerganov/whisper.cpp`: LFS sha256 and sizes as pinned in §7; licence MIT. https://github.com/ggml-org/whisper.cpp/blob/v1.9.5/models/README.md, https://huggingface.co/ggerganov/whisper.cpp
- **[T3]** OpenAI Whisper: "Whisper's code and model weights are released under the MIT License." `openai/whisper-large-v3-turbo` model card: license mit. https://github.com/openai/whisper#license, https://huggingface.co/openai/whisper-large-v3-turbo
- **[T4]** faster-whisper 1.2.1 (PyPI, 2025-10-31), CTranslate2 4.8.2 (PyPI, 2026-08-31). README: FFmpeg not needed (PyAV). CPU benchmark on 13 minutes of audio, small model: whisper.cpp 2m05s, faster-whisper fp32 2m37s, int8 1m42s. https://github.com/SYSTRAN/faster-whisper
- **[T5]** sherpa-onnx v1.13.8 (2026-09-10), Apache-2.0. NVIDIA `parakeet-tdt-0.6b-v3`: license cc-by-4.0, 25 languages tagged. https://github.com/k2-fsa/sherpa-onnx, https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3
- **[T6]** MDN, MediaRecorder: Baseline "widely available … since April 2021"; `isTypeSupported()`; `dataavailable` and `stop` order. https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder
- **[T7]** MDN, `getUserMedia()`: "available only in secure contexts (HTTPS)"; "user permission is always required." https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- **[T8]** MDN, `Permissions-Policy: microphone`: default allowlist `self`; when disallowed, `getUserMedia()` rejects with `NotAllowedError`. https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/microphone
- **[T9]** Node.js 24, `os.setPriority([pid, ]priority)`: -20 (high) to 19 (low), with constants in `os.constants.priority`. https://nodejs.org/docs/latest-v24.x/api/os.html
- **[T10]** FFmpeg licence: "licensed under the GNU Lesser General Public License (LGPL) version 2.1 or later"; with optional GPL parts, "the GPL applies to all of FFmpeg." https://ffmpeg.org/legal.html
- **[T11]** Ubuntu 24.04 `ffmpeg` 7:6.1.1-3ubuntu5 (apt policy on a 24.04 machine). Homebrew `ffmpeg` formula 9.0.2. https://formulae.brew.sh/formula/ffmpeg
- **[T12]** Node.js 24, `child_process.spawn`: `env` defaults to `process.env`; `signal` aborts the child; `killSignal` defaults to `SIGTERM`; `shell` defaults to `false`. https://nodejs.org/docs/latest-v24.x/api/child_process.html
- **[T13]** npm, `package.json`, `optionalDependencies`: build failures do not fail the install; "`npm install --omit=optional` will prevent these dependencies from being installed." https://docs.npmjs.com/cli/v11/configuring-npm/package-json#optionaldependencies
- **[M]** Measured 2026-10-11 with whisper.cpp v1.9.5 built from source (`GGML_NATIVE=ON`) on an 8-core x86-64 desktop CPU with AVX2, under WSL2, with other work running, 8 threads, beam size 5.
  - English: a public-domain LibriVox reading (120 s), scored against the Project Gutenberg text.
  - German: a self-generated clip, a public-domain fairy-tale opening plus a made-up project note, spoken by Piper TTS with a CC0-dataset voice.
  - WER is computed after lowercasing and removing punctuation. Numbers written as digits count as errors.
