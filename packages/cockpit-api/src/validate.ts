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

interface Ajv2020 {
  addSchema(schema: unknown, key?: string): void;
  getSchema(key: string): ValidateFn | undefined;
}

type AjvCtor = new (options: { allErrors: boolean; strict: boolean }) => Ajv2020;

const require = createRequire(import.meta.url);
const loaded = require("ajv/dist/2020.js") as AjvCtor | { default?: AjvCtor };
const Ajv2020: AjvCtor = typeof loaded === "function" ? loaded : loaded.default ?? (loaded as AjvCtor);

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "../schema/cockpit.schema.json");
const schema: unknown = JSON.parse(readFileSync(schemaPath, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
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
