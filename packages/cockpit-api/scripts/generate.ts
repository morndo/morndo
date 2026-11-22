// Writes src/generated.ts from schema/cockpit.schema.json.
// `generate.ts --check` exits 1 when the file differs from a fresh generation.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, type JSONSchema } from "json-schema-to-typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = join(root, "schema/cockpit.schema.json");
const outPath = join(root, "src/generated.ts");
const header = "// Generated from schema/cockpit.schema.json by scripts/generate.ts. Do not edit.\n";

export async function generate(): Promise<string> {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as JSONSchema;
  const compiled = await compile({ ...schema, title: "CockpitSchemaRoot" }, "CockpitSchemaRoot", {
    bannerComment: "",
    additionalProperties: false,
    unreachableDefinitions: true,
    ignoreMinAndMaxItems: true,
    format: true,
    unknownAny: true,
    strictIndexSignatures: true,
  });
  const body = compiled.replace(/export interface CockpitSchemaRoot \{[\s\S]*?\n\}\n?/g, "").trim();
  return `${header}${body}\n`;
}

const fresh = await generate();
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(outPath, "utf8");
  } catch {
    current = "";
  }
  if (current !== fresh) {
    console.error("src/generated.ts is out of date. Run node packages/cockpit-api/scripts/generate.ts");
    process.exit(1);
  }
} else {
  writeFileSync(outPath, fresh);
}
