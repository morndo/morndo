import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

interface Shape {
  type?: string;
  enum?: (string | number)[];
  properties?: Record<string, Shape>;
  required?: string[];
  maxLength?: number;
}

const released = new URL("../schema/released/1.json", import.meta.url);
const compat = new URL("../scripts/compat.ts", import.meta.url);

it("allows an added response value and refuses a removed value or a widened property type", () => {
  const contract = JSON.parse(readFileSync(released, "utf8")) as { $defs: Record<string, Shape> };
  const required = (name: string) => {
    const definition = contract.$defs[name];
    if (!definition) throw new Error(`Missing ${name}`);
    return definition;
  };
  const directory = mkdtempSync(join(tmpdir(), "cockpit-compat-"));
  try {
    const path = join(directory, "current.json");
    const check = () => {
      writeFileSync(path, JSON.stringify(contract));
      return spawnSync(process.execPath, [compat.pathname, "--current", path], { encoding: "utf8" });
    };
    const lane = required("LaneState");
    lane.enum?.push("paused");
    expect(check().status).toBe(0);
    const limit = required("DailyLimit");
    limit.enum?.push(100);
    const closed = check();
    expect(closed.status).toBe(1);
    expect(closed.stderr).toContain("DailyLimit: added value 100 without a reader fallback");
    limit.enum?.pop();
    lane.enum = lane.enum?.filter(value => value !== "warn") ?? [];
    expect(check().stderr).toContain('removed value "warn"');
    const view = required("LaneView");
    if (!view.properties) throw new Error("Missing lane properties");
    view.properties.title = { type: "number" };
    const breaking = check();
    expect(breaking.status).toBe(1);
    expect(breaking.stderr).toContain("LaneView.title: type changed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("checks OpenAPI operations and treats id patterns as part of the wire type", () => {
  const schema = JSON.parse(readFileSync(released, "utf8")) as {
    $defs: Record<string, Shape & { oneOf?: { const?: string; type?: string }[]; pattern?: string }>;
  };
  const routes = JSON.parse(readFileSync(new URL("../schema/released/1.openapi.json", import.meta.url), "utf8")) as {
    paths: Record<string, unknown>;
  };
  const directory = mkdtempSync(join(tmpdir(), "cockpit-routes-"));
  try {
    const current = join(directory, "current.json");
    const openapi = join(directory, "openapi.json");
    const check = () => {
      writeFileSync(current, JSON.stringify(schema));
      writeFileSync(openapi, JSON.stringify(routes));
      return spawnSync(process.execPath, [compat.pathname, "--current", current, "--current-openapi", openapi], { encoding: "utf8" });
    };
    schema.$defs.ModelState?.oneOf?.push({ const: "busy", type: "string" });
    expect(check().status).toBe(0);
    const draft = schema.$defs.DraftId;
    if (!draft) throw new Error("Missing DraftId");
    const originalPattern = draft.pattern ?? "";
    draft.pattern = "^[A-Za-z0-9][A-Za-z0-9-]{0,199}$";
    expect(check().stderr).toContain("DraftId: pattern changed");
    draft.pattern = originalPattern;
    delete routes.paths["/api/cockpit/topics/{id}/history"];
    expect(check().stderr).toContain("GET /api/cockpit/topics/{id}/history: removed operation");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("refuses to rewrite the release baseline at the same major", () => {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-baseline-"));
  const pkg = join(dir, "packages/cockpit-api");
  const schemaDir = join(pkg, "schema");
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  };
  try {
    mkdirSync(join(schemaDir, "released"), { recursive: true });
    mkdirSync(join(pkg, "scripts"));
    const candidate = join(schemaDir, "released/1.json");
    copyFileSync(released, candidate);
    copyFileSync(new URL("../schema/released/1.openapi.json", import.meta.url), join(schemaDir, "released/1.openapi.json"));
    copyFileSync(new URL("../schema/cockpit.schema.json", import.meta.url), join(schemaDir, "cockpit.schema.json"));
    copyFileSync(new URL("../schema/cockpit.openapi.json", import.meta.url), join(schemaDir, "cockpit.openapi.json"));
    const script = join(pkg, "scripts/compat.ts");
    copyFileSync(compat, script);
    git("init", "-q");
    git("add", "packages/cockpit-api");
    git("-c", "user.name=Demo", "-c", "user.email=demo@example.test", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "Release contract");
    const check = () => spawnSync(process.execPath, [script, "--base-ref", "HEAD"], { cwd: dir, encoding: "utf8" });
    expect(check().status).toBe(0);
    writeFileSync(candidate, readFileSync(candidate, "utf8") + "\n");
    const edited = check();
    expect(edited.status).toBe(1);
    expect(edited.stderr).toContain("1.json changed within its major version");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("declares device layouts, lane history and the new composer routes", () => {
  const routes = JSON.parse(readFileSync(new URL("../schema/cockpit.openapi.json", import.meta.url), "utf8")) as {
    paths: Record<string, Record<string, { parameters: { name: string }[] }>>;
  };
  for (const suffix of ["workspace", "settings"]) {
    expect(routes.paths[`/api/cockpit/${suffix}`]?.get?.parameters.map(item => item.name)).toContain("deviceId");
  }
  expect(routes.paths["/api/cockpit/topics/{id}/history"]?.get?.parameters.map(item => item.name)).toContain("laneId");
  expect(routes.paths["/api/cockpit/uploads"]?.post).toBeDefined();
  expect(routes.paths["/api/cockpit/recent"]?.get).toBeDefined();
});

it("rejects required upload fields and narrowed upload limits as input changes", () => {
  const contract = JSON.parse(readFileSync(released, "utf8")) as { $defs: Record<string, Shape> };
  const upload = contract.$defs.UploadInput;
  if (!upload?.properties?.name) throw new Error("Missing upload input");
  const folder = mkdtempSync(join(tmpdir(), "cockpit-upload-compat-"));
  try {
    const path = join(folder, "schema.json");
    const compare = () => {
      writeFileSync(path, JSON.stringify(contract));
      return spawnSync(process.execPath, [compat.pathname, "--current", path], { encoding: "utf8" });
    };
    const required = upload.required ?? [];
    upload.properties.kind = { type: "string" };
    upload.required = [...required, "kind"];
    const newField = compare();
    expect(newField.status).toBe(1);
    expect(newField.stderr).toContain("UploadInput.kind: new required input");
    upload.required = required;
    upload.properties.name = { ...upload.properties.name, maxLength: 10 };
    const narrower = compare();
    expect(narrower.status).toBe(1);
    expect(narrower.stderr).toContain("UploadInput.name: maxLength decreased");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
