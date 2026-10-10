// Decoding untrusted frames (ADR-0008, A2; design reference: Signal-Desktop ts/util/schemas.std.ts, which parses every
// untrusted value through zod). A frame is a JSON object with a string `t`. One of ours that fails its schema is
// malformed; a `t` we don't know is unknown, so an older peer ignores what a newer one adds.
import * as z from "./z.ts";

export type Schemas = Record<string, z.ZodMiniType>;
export type FrameOf<M extends Schemas> = { [K in keyof M]: z.output<M[K]> }[keyof M];
export type Decoded<M extends Schemas> = { kind: "ok"; frame: FrameOf<M> } | { kind: "unknown"; t: string } | { kind: "malformed" };

export function decodeValue<M extends Schemas>(schemas: M, value: unknown): Decoded<M> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { kind: "malformed" };
  const t = (value as { t?: unknown }).t;
  if (typeof t !== "string") return { kind: "malformed" };
  if (!Object.hasOwn(schemas, t)) return { kind: "unknown", t };
  const r = z.safeParse(schemas[t] as z.ZodMiniType, value);
  return r.success ? { kind: "ok", frame: r.data as FrameOf<M> } : { kind: "malformed" };
}

// A WebSocket text frame (or anything that stringifies to JSON).
export function decode<M extends Schemas>(schemas: M, raw: unknown): Decoded<M> {
  let value: unknown;
  try { value = JSON.parse(String(raw)); } catch { return { kind: "malformed" }; }
  return decodeValue(schemas, value);
}

// An HTTP JSON body: the value, or null when it doesn't fit.
export function parseBody<S extends z.ZodMiniType>(schema: S, value: unknown): z.output<S> | null {
  const r = z.safeParse(schema, value);
  return r.success ? r.data : null;
}

// For callers that take a schema without depending on zod themselves.
export type Schema = z.ZodMiniType;
export type Output<S extends Schema> = z.output<S>;
