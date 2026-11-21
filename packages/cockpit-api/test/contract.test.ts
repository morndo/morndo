import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { loadFixtures, validate } from "../src/index.ts";

for (const module of ["gtm", "dev"] as const) {
  describe(`${module} fixtures`, () => {
    const files = loadFixtures(module);
    it("has fixtures", () => {
      expect(files.length).toBeGreaterThan(0);
    });
    for (const file of files) {
      it(`${file.path} is a valid ${file.definition}`, () => {
        const result = validate(file.definition, file.value);
        expect(result.ok, result.ok ? "" : result.errors.join("\n")).toBe(true);
      });
    }
  });
}

it("generate.ts --check", () => {
  const result = spawnSync(process.execPath, ["packages/cockpit-api/scripts/generate.ts", "--check"], { encoding: "utf8" });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
});
