// Plugin protocol 1 and the transcription HTTP bodies (ADR-0021; design §5 and §6). The plugin writes one JSON
// document to stdout. A wrong protocol, a document that does not fit, or JSON that does not parse is bad_output.
// The HTTP bodies are what the app posts and what the hub answers with. Neither carries a filesystem path: the
// audio stays on the hub's machine (TX1). Schemas use zod 4.6.5's strictObject and discriminatedUnion
// (https://zod.dev/api, read 2026-10-13). Unknown keys on a plugin document fail; they are not dropped.
import {
  LANGUAGE_CHOICE, LANGUAGE_CODE, MAX_RECORDING_SECONDS, MAX_TEXT_BYTES, QUEUE_REASONS, TRANSCRIPTION_ID,
  TX_PROBLEMS, TX_STATES, TX_TERMINAL, err, ok, type Result, type TranscriptionProblem,
} from "@morndo/domain";
import * as z from "./z.ts";

export const PLUGIN_PROTOCOL = 1;

// Design §5. Zero is not a problem: the answer is the JSON. Two is usage, which is engine, as is any other code.
export const PLUGIN_EXIT = { usage: 2, unreadable: 3, too_long: 4, not_ready: 5 } as const;

export function problemFromExit(code: number): TranscriptionProblem | null {
  if (code === 0) return null;
  if (code === PLUGIN_EXIT.unreadable) return "unreadable";
  if (code === PLUGIN_EXIT.too_long) return "too_long";
  if (code === PLUGIN_EXIT.not_ready) return "not_ready";
  return "engine";
}

const text = (max: number) => z.string().check(z.minLength(1), z.maxLength(max));
const id = () => z.string().check(z.regex(TRANSCRIPTION_ID));
const choice = () => z.string().check(z.regex(LANGUAGE_CHOICE));
const code = () => z.string().check(z.regex(LANGUAGE_CODE));
const PROBLEMS = TX_PROBLEMS satisfies readonly TranscriptionProblem[];
const STATES = TX_STATES satisfies readonly (typeof TX_STATES)[number][];
const OUTCOMES = TX_TERMINAL satisfies readonly (typeof TX_TERMINAL)[number][];
const REASONS = QUEUE_REASONS;

// What a not-ready probe may name. "model" and "ffmpeg" are the two the design names; a short token still prints
// in doctor, and a path does not fit.
const missingItem = () => z.string().check(z.regex(/^[a-z][a-z0-9_-]{0,31}$/));
// What /api/me publishes: the hub's cap, already the lower of the setting and the probe (effectiveMaxSeconds).
const seconds = () => z.int().check(z.gte(1), z.lte(MAX_RECORDING_SECONDS));
// The probe may offer more. A day is the bound; the hub still keeps the lower of the two (domain effectiveMaxSeconds).
const PROBE_MAX_SECONDS = 24 * 60 * 60;
const probeSeconds = () => z.int().check(z.gte(1), z.lte(PROBE_MAX_SECONDS));
const languages = z.union([
  z.literal("multi"),
  z.array(code()).check(z.minLength(1), z.maxLength(64)),
]);

const probeReady = z.strictObject({
  protocol: z.literal(PLUGIN_PROTOCOL),
  ready: z.literal(true),
  engine: text(64),
  engineVersion: text(32),
  model: text(128),
  languages,
  maxSeconds: probeSeconds(),
  missing: z.array(missingItem()).check(z.maxLength(0)),
});
const probeAbsent = z.strictObject({
  protocol: z.literal(PLUGIN_PROTOCOL),
  ready: z.literal(false),
  missing: z.array(missingItem()).check(z.minLength(1), z.maxLength(8)),
});

export const ProbeDocument = z.discriminatedUnion("ready", [probeReady, probeAbsent]);
export type ProbeDocument = z.output<typeof ProbeDocument>;

// A run may report a duration past the cap: the domain then ends it too_long. Past a day, the document is not
// protocol 1. Segment text is bounded so a plugin cannot hand the hub an unbounded string; the domain still caps
// the joined words.
const MS_DAY = 24 * 60 * 60 * 1000;
const ms = () => z.int().check(z.gte(0), z.lte(MS_DAY));

export const RunDocument = z.strictObject({
  protocol: z.literal(PLUGIN_PROTOCOL),
  language: code(),
  durationMs: ms(),
  segments: z.array(z.strictObject({
    startMs: ms(),
    endMs: ms(),
    text: z.string().check(z.maxLength(MAX_TEXT_BYTES)),
  })).check(z.maxLength(10_000)),
});
export type RunDocument = z.output<typeof RunDocument>;

function jsonValue(stdout: string): Result<unknown, "bad_output"> {
  try {
    return ok(JSON.parse(stdout));
  } catch {
    return err("bad_output");
  }
}

function parsePlugin<S extends z.ZodMiniType>(schema: S, stdout: string): Result<z.output<S>, "bad_output"> {
  const value = jsonValue(stdout);
  if (!value.ok) return value;
  const parsed = z.safeParse(schema, value.value);
  return parsed.success ? ok(parsed.data) : err("bad_output");
}

export function parseProbe(stdout: string): Result<ProbeDocument, "bad_output"> {
  return parsePlugin(ProbeDocument, stdout);
}

export function parseRun(stdout: string): Result<RunDocument, "bad_output"> {
  return parsePlugin(RunDocument, stdout);
}

const recording = z.strictObject({
  kind: z.enum(["upload", "attachment"]),
  id: id(),
});

// POST /api/transcriptions. The hub reads the file's size itself; the body does not carry it or a path.
export const TranscriptionCreateBody = z.strictObject({
  id: id(),
  recording,
  language: choice(),
});
export type TranscriptionCreateBody = z.output<typeof TranscriptionCreateBody>;

const words = z.strictObject({
  language: code(),
  text: z.string().check(z.maxLength(MAX_TEXT_BYTES)),
  edit: z.nullable(z.string().check(z.minLength(1), z.maxLength(MAX_TEXT_BYTES))),
  edited: z.boolean(),
  engine: text(64),
  model: text(128),
});

// GET /api/transcriptions/:id and the create answer. Queued rows have a position and a reason; done rows have text.
export const TranscriptionView = z.strictObject({
  id: id(),
  recording,
  language: choice(),
  state: z.enum(STATES),
  position: z.nullable(z.int().check(z.gte(1))),
  reason: z.nullable(z.enum(REASONS)),
  outcome: z.nullable(z.enum(OUTCOMES)),
  problem: z.nullable(z.enum(PROBLEMS)),
  text: z.nullable(words),
});
export type TranscriptionView = z.output<typeof TranscriptionView>;

// POST /api/transcriptions/:id/cancel. The id is in the path. An empty object, and nothing else.
export const TranscriptionCancelBody = z.strictObject({});
export type TranscriptionCancelBody = z.output<typeof TranscriptionCancelBody>;

// The transcription field of /api/me: false when no ready plugin, otherwise what the probe reported.
export const MeTranscription = z.union([
  z.literal(false),
  z.strictObject({
    engine: text(64),
    model: text(128),
    languages,
    maxSeconds: seconds(),
  }),
]);
export type MeTranscription = z.output<typeof MeTranscription>;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const check = <T extends true>(t: T) => t;
type ViewProblem = Exclude<z.output<typeof TranscriptionView>["problem"], null>;
check<Same<ViewProblem, TranscriptionProblem>>(true);
