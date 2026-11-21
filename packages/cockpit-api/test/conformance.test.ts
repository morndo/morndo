import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { validate } from "../src/index.ts";

for (const [category, definition] of [["commands", "Command"], ["events", "Event"]]) {
  for (const verdict of ["valid", "invalid"]) {
    const dir = new URL(`../examples/${category}/${verdict}/`, import.meta.url);
    for (const name of readdirSync(dir)) {
      it(`${category}/${name} is ${verdict}`, () => {
        const value: unknown = JSON.parse(readFileSync(new URL(name, dir), "utf8"));
        const result = validate(definition ?? "", value);
        expect(result.ok, result.ok ? undefined : result.errors.join("\n")).toBe(verdict === "valid");
      });
    }
  }
}
