// Compare the current contract to the immutable baseline for its major version.
import { readFileSync } from "node:fs";

interface Shape {
  $ref?: string;
  type?: string | string[];
  format?: string;
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, Shape>;
  required?: string[];
  oneOf?: Shape[];
  anyOf?: Shape[];
  allOf?: Shape[];
  items?: Shape;
  additionalProperties?: boolean | Shape;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
}

interface Contract {
  $id: string;
  $defs: Record<string, Shape>;
  "x-contract-version": string;
}

const defaultSchema = new URL("../schema/cockpit.schema.json", import.meta.url);
const refPrefix = "#/$defs/";
const minimums = ["minLength", "minItems", "minimum"] as const;
const maximums = ["maxLength", "maxItems", "maximum"] as const;

function read(path: string | URL): Contract {
  return JSON.parse(readFileSync(path, "utf8")) as Contract;
}

function branchKey(shape: Shape): string {
  const tag = shape.properties?.type?.const ?? shape.properties?.kind?.const;
  if (tag !== undefined) return `tag:${JSON.stringify(tag)}`;
  if (shape.const !== undefined) return `const:${JSON.stringify(shape.const)}`;
  if (shape.enum) return `enum:${JSON.stringify(shape.type)}`;
  if (shape.$ref) return `ref:${shape.$ref}`;
  return `type:${JSON.stringify(shape.type)}`;
}

function reachable(defs: Contract["$defs"], root: string): Set<string> {
  const seen = new Set<string>();
  function visit(name: string) {
    if (seen.has(name) || !defs[name]) return;
    seen.add(name);
    for (const match of JSON.stringify(defs[name]).matchAll(/"#\/\$defs\/([^"]+)"/g)) visit(match[1] ?? "");
  }
  visit(root);
  return seen;
}

function compare(released: Contract, current: Contract): string[] {
  const issues: string[] = [];
  const fail = (path: string, detail: string) => issues.push(`${path}: ${detail}`);
  const inputs = reachable(released.$defs, "Command");
  const outputRoots = Object.keys(released.$defs).filter(name => !inputs.has(name) || name.endsWith("View"));
  const outputs = new Set(outputRoots.flatMap(root => [...reachable(released.$defs, root)]));
  if (released.$id !== current.$id) fail("$id", "changed within a major version");

  function check(old: Shape, next: Shape, path: string, input: boolean) {
    if (JSON.stringify(old.type) !== JSON.stringify(next.type) || old.$ref !== next.$ref || old.format !== next.format) {
      fail(path, "type changed");
    }
    if (JSON.stringify(old.const) !== JSON.stringify(next.const)) fail(path, "constant changed");
    if (next.enum && !old.enum) fail(path, "values restricted");
    if (next.enum && old.enum) {
      for (const value of old.enum) {
        if (!next.enum.some(candidate => JSON.stringify(candidate) === JSON.stringify(value))) {
          fail(path, `removed value ${JSON.stringify(value)}`);
        }
      }
    }
    if (input) {
      if (next.pattern && next.pattern !== old.pattern) fail(path, "input pattern changed");
      for (const key of minimums) if ((next[key] ?? -Infinity) > (old[key] ?? -Infinity)) fail(path, `${key} increased`);
      for (const key of maximums) if ((next[key] ?? Infinity) < (old[key] ?? Infinity)) fail(path, `${key} decreased`);
      if (next.additionalProperties === false && old.additionalProperties !== false) fail(path, "additional inputs disallowed");
      for (const field of next.required ?? []) if (!old.required?.includes(field)) fail(`${path}.${field}`, "new required input");
    } else {
      for (const field of old.required ?? []) if (!next.required?.includes(field)) fail(`${path}.${field}`, "response field became optional");
    }
    for (const [field, shape] of Object.entries(old.properties ?? {})) {
      const replacement = next.properties?.[field];
      if (!replacement) fail(`${path}.${field}`, "removed property");
      else check(shape, replacement, `${path}.${field}`, input);
    }
    if (old.items && next.items) check(old.items, next.items, `${path}[]`, input);
    else if (Boolean(old.items) !== Boolean(next.items)) fail(path, "array item type changed");
    for (const name of ["oneOf", "anyOf", "allOf"] as const) {
      const parts = next[name] ?? [];
      for (const branch of old[name] ?? []) {
        const key = branchKey(branch);
        const replacement = parts.find(part => branchKey(part) === key);
        if (!replacement) fail(path, `removed ${name} member ${key}`);
        else check(branch, replacement, `${path}/${key}`, input);
      }
    }
  }

  for (const [name, old] of Object.entries(released.$defs)) {
    const next = current.$defs[name];
    if (!next) {
      fail(name, "removed definition");
      continue;
    }
    if (inputs.has(name)) check(old, next, name, true);
    if (outputs.has(name) || !inputs.has(name)) check(old, next, name, false);
  }
  return [...new Set(issues)];
}

try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--current")) {
    throw new Error("usage: compat.ts [--current <schema>]");
  }
  const current = read(args[1] ?? defaultSchema);
  const major = /^([1-9]\d*)\.\d+\.\d+$/.exec(current["x-contract-version"])?.[1];
  if (!major || current.$id !== `urn:morndo:cockpit-api:${major}`) throw new Error("invalid contract version or schema identifier");
  const baseline = read(new URL(`../schema/released/${major}.json`, import.meta.url));
  const issues = compare(baseline, current);
  if (issues.length) {
    console.error(issues.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Cockpit schema ${current["x-contract-version"]} is compatible with ${baseline["x-contract-version"]}.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
