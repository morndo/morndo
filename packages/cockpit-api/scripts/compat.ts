// Compare the current contract to the immutable baseline for its major version.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

interface Shape {
  $ref?: string;
  $comment?: string;
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
const minimums = ["minLength", "minItems", "minimum"] as const;
const maximums = ["maxLength", "maxItems", "maximum"] as const;

function read(path: string | URL): Contract {
  return JSON.parse(readFileSync(path, "utf8")) as Contract;
}

function typeKey(type: Shape["type"]): string {
  return JSON.stringify(Array.isArray(type) ? [...type].sort() : type) ?? "";
}

function branchKey(shape: Shape): string {
  const tag = shape.properties?.type?.const ?? shape.properties?.kind?.const;
  if (tag !== undefined) return `tag:${JSON.stringify(tag)}`;
  if (shape.const !== undefined) return `const:${JSON.stringify(shape.const)}`;
  if (shape.enum) return `enum:${typeKey(shape.type)}`;
  if (shape.$ref) return `ref:${shape.$ref}`;
  return `type:${typeKey(shape.type)}`;
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

interface Operation {
  parameters?: { name: string; in: string; required?: boolean; schema: Shape }[];
  requestBody?: { required?: boolean; content: Record<string, { schema?: Shape }> };
  responses: Record<string, { content?: Record<string, { schema?: Shape }> }>;
}
interface OpenApi {
  paths: Record<string, Record<string, Operation>>;
}

function compareRoutes(released: OpenApi, current: OpenApi): string[] {
  const failures: string[] = [];
  for (const [path, operations] of Object.entries(released.paths)) {
    for (const [method, before] of Object.entries(operations)) {
      const label = `${method.toUpperCase()} ${path}`;
      const after = current.paths[path]?.[method];
      if (!after) {
        failures.push(`${label}: removed operation`);
        continue;
      }
      const params = after.parameters ?? [];
      for (const prior of before.parameters ?? []) {
        const next = params.find(item => item.name === prior.name && item.in === prior.in);
        if (!next || JSON.stringify(next.schema) !== JSON.stringify(prior.schema)) {
          failures.push(`${label}: removed or changed parameter ${prior.name}`);
        }
      }
      for (const next of params) {
        if (next.required && !before.parameters?.some(item => item.name === next.name && item.in === next.in && item.required)) {
          failures.push(`${label}: new required parameter ${next.name}`);
        }
      }
      if (after.requestBody?.required && !before.requestBody?.required) {
        failures.push(`${label}: new required request body`);
      }
      for (const [media, body] of Object.entries(before.requestBody?.content ?? {})) {
        const candidate = after.requestBody?.content[media];
        if (!candidate || JSON.stringify(candidate.schema) !== JSON.stringify(body.schema)) {
          failures.push(`${label}: removed or changed request body ${media}`);
        }
      }
      for (const [status, response] of Object.entries(before.responses)) {
        const actual = after.responses[status];
        if (!actual || Object.entries(response.content ?? {}).some(([media, body]) =>
          !actual.content?.[media] || body.schema?.$ref !== actual.content[media]?.schema?.$ref)) {
          failures.push(`${label}: removed or changed response ${status}`);
        }
      }
    }
  }
  return failures;
}

function checkBaseline(ref: string, path: string, current: URL): void {
  const git = (args: string[]) => spawnSync("git", args, { encoding: "utf8" });
  const revision = git(["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"]);
  if (revision.status !== 0) throw new Error("Could not read baseline revision");
  const tracked = git(["ls-tree", "--name-only", revision.stdout.trim(), "--", path]);
  if (tracked.status !== 0) throw new Error("Could not inspect baseline revision");
  // A baseline is released once the base revision (the PR's base, or the previous push) holds it; before that it may
  // still be rewritten on its branch. A released baseline never changes within its major version.
  const references = new Set(tracked.stdout.trim() ? [revision.stdout.trim()] : []);
  const bytes = readFileSync(current, "utf8");
  for (const version of references) {
    const previous = git(["show", `${version}:${path}`]);
    if (previous.status !== 0 || previous.stdout !== bytes) {
      throw new Error(`${path} changed within its major version`);
    }
  }
}

function compare(released: Contract, current: Contract, routes: OpenApi): string[] {
  const issues: string[] = [];
  const fail = (path: string, detail: string) => issues.push(`${path}: ${detail}`);
  const requestRoots = Object.values(routes.paths).flatMap(operations => Object.values(operations)).flatMap(operation => {
    const body = JSON.stringify(operation.requestBody ?? {});
    return Array.from(body.matchAll(/"#\/components\/schemas\/([^"]+)"/g), match => match[1] ?? "");
  });
  const inputs = new Set(["Command", ...requestRoots].flatMap(name => [...reachable(released.$defs, name)]));
  const outputRoots = Object.keys(released.$defs).filter(name => !inputs.has(name) || name.endsWith("View"));
  const outputs = new Set(outputRoots.flatMap(root => [...reachable(released.$defs, root)]));
  if (released.$id !== current.$id) fail("$id", "changed within a major version");

  function check(old: Shape, next: Shape, path: string, input: boolean) {
    if (typeKey(old.type) !== typeKey(next.type) || old.$ref !== next.$ref || old.format !== next.format) {
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
      if (!input && old.$comment !== "cockpit-reader:enum") {
        for (const value of next.enum) {
          if (!old.enum.some(candidate => JSON.stringify(candidate) === JSON.stringify(value))) {
            fail(path, `added value ${JSON.stringify(value)} without a reader fallback`);
          }
        }
      }
    }
    if (next.additionalProperties === false && old.additionalProperties !== false) fail(path, "additional properties disallowed");
    if (old.pattern !== next.pattern && (old.pattern !== undefined || input)) fail(path, "pattern changed");
    if (input) {
      for (const key of minimums) if ((next[key] ?? -Infinity) > (old[key] ?? -Infinity)) fail(path, `${key} increased`);
      for (const key of maximums) if ((next[key] ?? Infinity) < (old[key] ?? Infinity)) fail(path, `${key} decreased`);
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
      const previous = old[name] ?? [];
      const parts = next[name] ?? [];
      for (const added of parts.filter(part => !previous.some(branch => branchKey(branch) === branchKey(part)))) {
        const tag = branchKey(added).startsWith("tag:");
        const enumValue = added.const !== undefined && previous.length > 0 && previous.every(part =>
          part.const !== undefined ? typeof part.const === typeof added.const
            : Boolean(part.enum?.length && part.enum.every(value => typeof value === typeof added.const)));
        const taggedFallback = old.$comment?.startsWith("cockpit-reader:tag:") ?? false;
        const allowed = (name === "oneOf" || name === "anyOf")
          && ((tag && (input || taggedFallback) && previous.some(part => branchKey(part).startsWith("tag:")))
            || (enumValue && (input || old.$comment === "cockpit-reader:enum")));
        if (!allowed) fail(path, `added ${name} member ${branchKey(added)} changes the type`);
      }
      for (const branch of previous) {
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
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i] ?? "";
    const value = args[i + 1];
    if (!["--current", "--current-openapi", "--base-ref"].includes(flag) || !value || options.has(flag)) {
      throw new Error("usage: compat.ts [--current <schema>] [--current-openapi <document>] [--base-ref <revision>]");
    }
    options.set(flag, value);
  }
  const current = read(options.get("--current") ?? defaultSchema);
  const major = /^([1-9]\d*)\.\d+\.\d+$/.exec(current["x-contract-version"])?.[1];
  if (!major || current.$id !== `urn:morndo:cockpit-api:${major}`) throw new Error("invalid contract version or schema identifier");
  const baselineUrl = new URL(`../schema/released/${major}.json`, import.meta.url);
  const baselineRoutes = new URL(`../schema/released/${major}.openapi.json`, import.meta.url);
  const ref = options.get("--base-ref");
  if (ref) {
    checkBaseline(ref, `packages/cockpit-api/schema/released/${major}.json`, baselineUrl);
    checkBaseline(ref, `packages/cockpit-api/schema/released/${major}.openapi.json`, baselineRoutes);
  }
  const baseline = read(baselineUrl);
  const readRoutes = (path: string | URL) => JSON.parse(readFileSync(path, "utf8")) as OpenApi;
  const releasedRoutes = readRoutes(baselineRoutes);
  const issues = [
    ...compare(baseline, current, releasedRoutes),
    ...compareRoutes(releasedRoutes, readRoutes(options.get("--current-openapi") ?? new URL("../schema/cockpit.openapi.json", import.meta.url))),
  ];
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
