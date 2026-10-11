# ADR-0021: Voice messages become text on the user's own machine, through a transcription plugin that the default install does not include

- **Status:** Proposed, 2026-10-11. Design: [`docs/design/transcription/README.md`](../design/transcription/README.md). Design only; no product code.
- **The request:** transcribe audio with a free, open-source transcriber. Integrate it as a plugin or package that the default install does not include, so installing it is entirely optional. Keep it modular, and follow DDD where possible.
- **Number:** 0019 (releases and updates) and 0020 (auto routing) are taken on branches. 0021 is the next free number on `main` and on every branch (checked 2026-10-11).
- **Builds on:**
  - ADR-0001: pure domain, adapters at the edges.
  - ADR-0006 and ADR-0011: files in chat and the phone chat.
  - ADR-0012: FL14, and the node is not an isolation boundary.
  - ADR-0013: an external CLI behind a probe hides a page when the CLI is missing.
  - ADR-0017: classes, limits, the guard, outcomes.
  - ADR-0018: an optional app reached only as a child process.
  - ADR-0019 (proposed): signed per-platform archives, `morndo doctor`.
- **Sources:** [T1]–[T13] in the design, section 16, all checked 2026-10-11.

## Context

1. **Audio has no way in today.**
   - The upload rule (S1, `packages/domain/src/steering.ts`) accepts images, PDF and text. Any audio file is refused as `not_allowed`.
   - The hub sends `Permissions-Policy: microphone=()` (`apps/hub/src/adapters/http.ts`), so the web app cannot record.
   - The desktop plays audio that agents send (`desktop/Attachments.svelte`). The phone shows only a file chip.
2. **Agents can't listen.** The agent CLIs a lane runs read text and images. A voice note is useful to them only as text.
3. **Speech-to-text is heavy, and not everyone wants it.**
   - A good multilingual model is 0.5 to 1.5 GB.
   - Decoding a phone's opus or AAC needs ffmpeg.
   - On an 8-core desktop CPU, the best CPU model runs at about real time; the measurements are in the design, §1.
   - A user on a small VPS, or one who never speaks to their agents, should pay none of this.
4. **Morndo has no plugin mechanism.** It has no `import()` loader, no `optionalDependencies` and no extension registry.
   - Optional features follow one pattern:
     - an environment variable or a null port;
     - a route that answers 404 `<x>_off`;
     - a boolean in `/api/me` that the web app uses to hide the feature.
   - The Engines page goes one step further and probes an external CLI, so a missing or too-old CLI also hides the feature (ADR-0013).
5. **Background jobs (ADR-0017) are an agent's commands.** A Job is started on a node by a lane, for a lane, and reports one notice whose tail is cut to 40 lines and redacted. The hub does not start Jobs, and starting one is not a fleet operation.
6. **The candidates, checked live** (design, §1):
   - **whisper.cpp v1.9.5:** MIT. One C++ binary. The OpenAI Whisper weights are MIT.
   - **faster-whisper 1.2.1:** MIT. A Python stack. Last release 2025-10-31.
   - **sherpa-onnx 1.13.8:** Apache-2.0. Paired with NVIDIA Parakeet TDT 0.6B v3, whose weights are CC-BY-4.0.

## Decision

1. **A Transcription context, pure.** It is a new bounded context in `packages/domain/src/transcription.ts`.
   - **Recording:** an audio Upload, or an audio Attachment an agent sent.
   - **Transcription:** one attempt to turn one Recording into text, with its queue state, its outcome and its Text.
   - The invariants are TX1–TX9.
   - It imports no process, file system or model name.
   - "Transcript" stays Observation's word for a worker's session log. This context never uses it.
2. **One port, `Transcriber`.** It has `probe()` and `transcribe()` and lives in the hub's `application/ports.ts`. Following the repo's naming, the port is named for what it does, with no `Port` suffix.
   - The hub ships a process adapter: about 150 lines with no dependencies.
   - It runs a plugin executable with an argument vector, a clean environment, a temporary working directory, a lower priority and a timeout, and reads one JSON document back.
   - A fake adapter and a fixture plugin are used in tests.
3. **The engine is a separate package, outside the workspaces.**
   - `plugins/transcribe-whisper-cpp` has its own `package.json` and lockfile. Its bin is `morndo-transcribe`.
   - The root `workspaces` (`packages/*`, `apps/*`) don't include it. So `npm ci`, the build and the release archives contain none of it, and a test proves that.
   - It speaks **plugin protocol 1**: `probe --json` and `run --input … --language … --json`.
   - Any other engine can implement the same protocol in any language: faster-whisper, sherpa-onnx with Parakeet, or a later Whisper.
4. **Discovery is a probe of one known path.**
   - The hub looks at `MORNDO_TRANSCRIBER` if it is set. Otherwise it looks at `<MORNDO_HOME>/plugins/transcribe/bin/morndo-transcribe`. It never searches `PATH`.
   - The file must be the user's own and must not be group- or world-writable.
   - A probe result is cached for 60 seconds.
   - When the plugin is absent, not ready (no model, no ffmpeg) or speaks another protocol version:
     - `/api/me` reports `transcription: false`;
     - transcription routes answer 404 `transcription_off`;
     - audio uploads are refused exactly as today;
     - the microphone stays blocked by `Permissions-Policy`;
     - the UI shows no microphone and no "Transcribe" button.
   - One log line is written when that state changes. Nothing else.
5. **Opting in is one command, and only checksummed bytes run.**
   - Until ADR-0019 ships, `npm run plugin:transcribe -- --model <id>` from a checkout:
     - builds whisper.cpp from a pinned tag;
     - downloads the chosen model from its Hugging Face repository and verifies the sha256 pinned in the plugin's manifest;
     - checks for ffmpeg, then runs `probe`.
   - With ADR-0019, the plugin becomes an optional per-platform artifact in the signed release manifest: `morndo plugin add transcribe [--model …]`, and `morndo plugin remove transcribe`. The manifest ships the digests, never the bytes.
   - ffmpeg is a system prerequisite, called as a separate program and never bundled.
6. **Local only.** A Transcription runs on the hub's machine, where the Upload already is.
   - The plugin needs the network only at install time. The run step is tested with networking disabled.
   - No adapter sends audio to a third-party service. Such an adapter would need its own ADR and an explicit opt-in.
   - Transcribing on another of the user's own machines (an office node that advertises the capability) is a later typed fleet operation, not v1.
7. **CPU limits reuse the Job rules, not Job rows.**
   - The hub's `TranscriptionService` queues with ADR-0017's rule J5:
     - a class limit, `1` by default;
     - FIFO order with a visible position;
     - the optional load and memory guard that only delays a start.
   - The outcomes are those of Jobs, with `done` for a clean exit: `done`, `failed`, `timed_out`, `cancelled`, `lost`.
   - The plugin runs at `PRIORITY_BELOW_NORMAL` with `threads = min(8, floor(cores / 2))`.
   - The timeout is `120 s + 6 × duration`. Recordings are capped at 600 s.
   - A hub restart marks a running Transcription `lost`. It is never re-run on its own.
   - PR 1 extracts the queue decision from `jobs.ts` into one pure function both contexts call. Job behaviour does not change, and the existing job tests prove it.
8. **The text is a draft until the principal sends it.**
   - After a recording, the composer fills with the text, which can be edited. The principal reviews it and sends.
   - The Command carries the text, then the audio's file note (S3 order).
   - When the text does not fit the send cap (`maxSendText`, 8000), it goes as a `.md` text Upload next to the audio, and the Command names both.
   - The audio is never replaced. An edit records that it was edited.
   - Text from an agent's audio stays that agent's content, shown beside the file. It never becomes a Command.
9. **No general plugin system yet.**
   - This ADR writes down a small convention for "an optional capability provided by an external executable":
     - a directory under `<MORNDO_HOME>/plugins/<name>/`;
     - `probe --json` with a protocol number;
     - a boolean in `/api/me`;
     - a 404 `<name>_off`.
   - A registry, a loader, `morndo plugin` subcommands beyond add, remove and list, and a store wait for a second plugin that needs them.

## Alternatives

| Option | Verdict |
|---|---|
| **Ship transcription in the default install** | Rejected. It would add a gigabyte and a native binary to every install, and most users never record. |
| **`optionalDependencies` or `import()` of an npm package into the hub** | Rejected. Native code would load into the hub process, where one crash takes the hub down. It ties the engine to Node's ABI. npm installs optional dependencies unless the user passes `--omit=optional` [T13], so they would not be optional by default. A process boundary keeps the hub clean and lets the engine be any language. |
| **Search `PATH` for `morndo-transcribe`** | Rejected. Discovery would depend on the shell that started the hub, and an unrelated binary of that name would be trusted. One known path plus one variable is predictable, and `doctor` can check it. |
| **Run each transcription as an ADR-0017 Job** | Rejected for v1. A Job is a lane's command with a lane notice, and its tail is cut and redacted, but a text must stay whole. The hub can't start Jobs (ADR-0017, decision 1), and a single-host hub may have no node agent. The rules are reused; the rows are not. |
| **faster-whisper as the first engine** | Second. It has similar CPU speed, but needs a Python environment with CTranslate2 and PyAV wheels on every machine, and its last release is from 2025-10. It fits protocol 1 as a later adapter. |
| **sherpa-onnx with Parakeet TDT 0.6B v3** | Later adapter. It is fast on CPU and covers 25 European languages, but the weights are CC-BY-4.0, which needs attribution shown to users, and it has fewer languages than Whisper. |
| **Transcribe in the browser (WASM)** | Rejected. A 0.5 GB model would download to every phone, and it would be slow on mid-range phones. |
| **A cloud speech API** | Rejected as a default. Audio would leave the user's machines. The port would allow one later, behind its own ADR and opt-in (TX1). |
| **Bundle a static ffmpeg** | Rejected. Its licence depends on the build: LGPL 2.1 or later, or GPL once optional parts are enabled [T10]. We would ship and track a second native binary per platform. ffmpeg comes from the system's package manager (Ubuntu's `ffmpeg` package, Homebrew's `ffmpeg` formula [T11]), and `probe` reports when it is missing. |
| **Auto-send a voice note's text without review** | Not the default. The principal sees what the agent will read; a misheard word ("pull request" heard as something else) is fixed before it becomes a Command. It is offered as a setting (choice 2). |
| **A general plugin framework now** | Rejected for now. There is one plugin; the convention in decision 9 is what a second one would reuse. |

## Consequences

- **Good:** a default install is unchanged: the same dependencies, the same upload rules, the microphone blocked, and no new routes answering. The opt-in is one command, and removing the directory turns the feature off within a minute.
- **Good:** the principal can speak to any lane from the phone and review the text before sending. Agents get text they can act on, and the audio stays on the hub for reference.
- **Good:** an engine is replaceable without hub changes, since protocol 1 is the contract and contract tests hold every adapter to it.
- **Cost:**
  - one domain module, one port with its adapter, one store migration and one web feature;
  - a separate package with its own CI job, which builds whisper.cpp and downloads a 142 MiB model, both cached;
  - ffmpeg on hubs that opt in.
- **Limit:**
  - Quality depends on the model. German is good with large-v3-turbo; English loanwords in German speech are the common errors.
  - Speed depends on the CPU. On 2 vCPUs, the `small` model is the realistic choice.
- **Limit:** the hub's machine does the work. A strong office machine helps only after the later fleet operation.
- **Risk:** the decoder parses untrusted bytes. The bytes come only from the principal's authenticated devices or from an agent's files on the user's own machines, the process runs as the user (ADR-0012's threat model), and it has a timeout, a low priority and a clean environment.

## Verification this implies

1. Domain tests for TX1–TX9: states, idempotence, the duration and text caps, an edit, and a hub restart that gives `lost`. Each has a negative control.
2. Contract tests for the `Transcriber` port, run against the fake, against the process adapter with a fixture plugin (bad JSON, a wrong protocol, a timeout, oversized output, an abort), and against the real plugin when it is installed. That last suite is skipped with a printed reason otherwise.
3. Absence tests: with no plugin, `/api/me` reports `transcription: false`, routes return 404 `transcription_off`, an `.ogg` upload is refused 415 as on `main`, `Permissions-Policy` still blocks the microphone, and the root lockfile names no plugin package.
4. A CI job installs the plugin with the `base` model, runs the contract suite and one end-to-end send, and runs the plugin with networking disabled.
5. Manual QA: record on a phone, see the text, edit it, send it, and read it in the lane. Then remove the plugin and confirm the microphone is gone. Notes stay outside the repo, as AGENTS.md requires.
