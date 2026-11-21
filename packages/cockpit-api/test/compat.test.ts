import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

interface Shape {
  type?: string;
  enum?: string[];
  properties?: Record<string, Shape>;
  required?: string[];
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
