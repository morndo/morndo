import { cockpitSchema, createValidator, validateWith, type ValidationResult } from "./validate.ts";
import type { FeedFrame } from "./generated.ts";

interface Shape {
  $ref?: string;
  $comment?: string;
  type?: string | string[];
  const?: string;
  enum?: string[];
  properties?: Record<string, Shape>;
  required?: string[];
  items?: Shape;
  oneOf?: Shape[];
  anyOf?: Shape[];
}

const enumMarker = "cockpit-reader:enum";
const tagMarker = "cockpit-reader:tag:";
const unknown = "unknown";
const source = cockpitSchema as typeof cockpitSchema & { $defs: Record<string, Shape> };
const definitions = source.$defs;
const receiver = structuredClone(source);

function tagFor(shape: Shape): string | undefined {
  return shape.$comment?.startsWith(tagMarker) ? shape.$comment.slice(tagMarker.length) : undefined;
}

function enumValue(shape: Shape, value: string): boolean {
  return shape.const === value || Boolean(shape.enum?.includes(value)) ||
    Boolean(shape.oneOf?.some(item => enumValue(item, value)));
}

for (const definition of Object.values(receiver.$defs)) {
  if (definition.$comment === enumMarker) {
    if (definition.enum) definition.enum.push(unknown);
    else if (definition.oneOf) definition.oneOf.push({ type: "string", const: unknown });
  }
  const tag = tagFor(definition);
  if (tag && definition.oneOf) {
    definition.oneOf.push({ type: "object", properties: { [tag]: { type: "string", const: unknown } }, required: [tag] });
  }
}

const ajv = createValidator(receiver);

function normalize(shape: Shape, data: unknown): unknown {
  if (shape.$ref) {
    const target = definitions[shape.$ref.slice("#/$defs/".length)];
    return target ? normalize(target, data) : data;
  }
  if (shape.$comment === enumMarker) return typeof data === "string" && !enumValue(shape, data) ? unknown : data;
  if (Array.isArray(data) && shape.items) {
    const items = shape.items;
    return data.map(item => normalize(items, item));
  }
  const record = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
  const tag = tagFor(shape);
  if (tag && record && typeof record[tag] === "string") {
    const branch = shape.oneOf?.find(item => item.properties?.[tag]?.const === record[tag]);
    if (!branch) {
      const envelope = Object.fromEntries(Object.keys(shape.properties ?? {}).flatMap(key => key in record ? [[key, record[key]]] : []));
      return { ...envelope, [tag]: unknown };
    }
    return normalize(branch, normalizeProperties(shape, record));
  }
  if (shape.anyOf) {
    const branch = shape.anyOf.find(item => item.type === "null" ? data === null : data !== null);
    if (branch) return normalize(branch, data);
  }
  return record ? normalizeProperties(shape, record) : data;
}

function normalizeProperties(shape: Shape, record: Record<string, unknown>): Record<string, unknown> {
  const result = { ...record };
  for (const [key, prop] of Object.entries(shape.properties ?? {})) {
    if (Object.hasOwn(record, key)) result[key] = normalize(prop, record[key]);
  }
  return result;
}

/** Parse a response using the installed reader's fallbacks. Use validate for hub writes and command inputs. */
export function parseResponse(definition: string, data: unknown): ValidationResult<unknown> {
  const frame = data && typeof data === "object" && "type" in data && data.type === "feed.reset" && !("seq" in data);
  const name = definition === "FeedFrame" ? frame ? "FeedResetSignal" : "FeedEvent" : definition;
  const shape = definitions[name];
  if (!shape) return { ok: false, errors: [`no definition ${name}`] };
  return validateWith(ajv, name, normalize(shape, data));
}

/** Future enum strings use the same fallback as installed Rust readers. */
export type ReaderValue<T> = T extends string ? T | "unknown"
  : T extends readonly (infer Item)[] ? ReaderValue<Item>[]
    : T extends object ? { [Key in keyof T]: ReaderValue<T[Key]> }
      : T;

/** Header of a feed event whose payload is newer than this reader. */
export interface UnknownFeedEvent {
  type: "unknown";
  at: string;
  seq: number;
}

/** Parse a live frame without refusing new event types. */
export function parseFeedFrame(data: unknown): ValidationResult<ReaderValue<FeedFrame> | UnknownFeedEvent> {
  return parseResponse("FeedFrame", data) as ValidationResult<ReaderValue<FeedFrame> | UnknownFeedEvent>;
}
