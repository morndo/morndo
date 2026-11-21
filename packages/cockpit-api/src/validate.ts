import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  addSchema(schema: unknown, key?: string): void;
  getSchema(key: string): ValidateFn | undefined;
  addFormat(name: string, format: NumberFormat): void;
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
const schema: unknown = JSON.parse(readFileSync(schemaPath, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
const formats: readonly (readonly [string, (value: number) => boolean])[] = [
  ["int32", int32],
  ["uint32", uint32],
  ["int64", int64],
  ["uint64", uint64],
  ["double", double],
];
for (const [name, check] of formats) ajv.addFormat(name, { type: "number", validate: check });
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

/** Validate `value` against one `$defs` entry of the cockpit schema. */
export function validate<T = unknown>(def: string, value: unknown): ValidationResult<T> {
  const check = ajv.getSchema(`cockpit#/$defs/${def}`);
  if (!check) return { ok: false, errors: [`no definition ${def}`] };
  if (check(value)) return { ok: true, value: value as T };
  const errors = (check.errors ?? []).map((error) => `${error.instancePath ?? ""} ${error.message ?? "invalid"}`.trim());
  return { ok: false, errors };
}
