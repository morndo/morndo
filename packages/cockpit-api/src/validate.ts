import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FormatsPlugin } from "ajv-formats";

interface SchemaError {
  instancePath?: string;
  message?: string;
}

interface ValidateFn {
  (data: unknown): boolean;
  errors?: SchemaError[] | null;
}

interface NumberFormat {
  type: "number";
  validate: (value: number) => boolean;
}

interface Ajv2020 {
  addKeyword(name: string): void;
  addSchema(schema: unknown, key?: string): void;
  compile(schema: unknown): ValidateFn;
  getSchema(key: string): ValidateFn | undefined;
  addFormat(name: string, format: NumberFormat): void;
}

interface CommandVariant {
  properties?: { type?: { const?: unknown } };
  [key: string]: unknown;
}

type AjvCtor = new (options: { allErrors: boolean; strict: boolean }) => Ajv2020;

const require = createRequire(import.meta.url);
const loaded = require("ajv/dist/2020.js") as AjvCtor | { default?: AjvCtor };
const Ajv2020: AjvCtor = typeof loaded === "function" ? loaded : loaded.default ?? (loaded as AjvCtor);

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const UINT32_MAX = 4294967295;

function int32(value: number): boolean {
  return Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX;
}

function uint32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= UINT32_MAX;
}

/** Practical int64 bound: every integer JavaScript can represent exactly, which sits inside ±2^63. */
function int64(value: number): boolean {
  return Number.isSafeInteger(value);
}

function uint64(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function double(value: number): boolean {
  return Number.isFinite(value);
}

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "../schema/cockpit.schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as { "x-contract-version": string };

export const contractVersion = schema["x-contract-version"];
const ajv = new Ajv2020({ allErrors: false, strict: true });
const addFormats = require("ajv-formats") as FormatsPlugin;
addFormats(ajv as Parameters<FormatsPlugin>[0], ["date-time", "uri"]);
const formats: readonly (readonly [string, (value: number) => boolean])[] = [
  ["int32", int32],
  ["uint32", uint32],
  ["uint16", (value) => Number.isInteger(value) && value >= 0 && value <= 65535],
  ["uint8", (value) => Number.isInteger(value) && value >= 0 && value <= 255],
  ["int64", int64],
  ["uint64", uint64],
  ["double", double],
];
for (const [name, check] of formats) ajv.addFormat(name, { type: "number", validate: check });
ajv.addKeyword("x-contract-version");
ajv.addSchema(schema, "cockpit");

export interface ValidationOk<T> {
  ok: true;
  value: T;
}

export interface ValidationErr {
  ok: false;
  errors: string[];
}

export type ValidationResult<T> = ValidationOk<T> | ValidationErr;

function formatErrors(errors: SchemaError[] | null | undefined): string[] {
  return (errors ?? []).map((error) => `${error.instancePath ?? ""} ${error.message ?? "invalid"}`.trim());
}

const variantChecks = new Map<string, ValidateFn>();

function commandCheck(type: string): ValidateFn | undefined {
  const cached = variantChecks.get(type);
  if (cached) return cached;
  const root = schema as { $defs?: { Command?: { oneOf?: CommandVariant[] } } };
  const variant = root.$defs?.Command?.oneOf?.find((item) => item.properties?.type?.const === type);
  if (!variant) return undefined;
  const check = ajv.compile({ $defs: root.$defs, ...variant });
  variantChecks.set(type, check);
  return check;
}

/** Validate `value` against one `$defs` entry of the cockpit schema. */
export function validate<T = unknown>(def: string, value: unknown): ValidationResult<T> {
  const check = ajv.getSchema(`cockpit#/$defs/${def}`);
  if (!check) return { ok: false, errors: [`no definition ${def}`] };
  if (check(value)) return { ok: true, value: value as T };
  return { ok: false, errors: formatErrors(check.errors) };
}

/**
 * Failures for one command.
 * An unknown `type` is a single sentence. A known `type` reports only that variant.
 */
export function commandErrors(value: unknown): string[] {
  const type = value && typeof value === "object" && "type" in value ? (value as { type: unknown }).type : undefined;
  if (typeof type !== "string") return ['unknown command type ""'];
  const check = commandCheck(type);
  if (!check) return [`unknown command type "${type}"`];
  if (check(value)) return [];
  return formatErrors(check.errors);
}
