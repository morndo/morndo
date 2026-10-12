// A setup file of the units project. A test file that starts Chromium belongs to the chromium project, which runs a few
// at a time after everything else; vitest.config.ts finds those files by their imports (startsChromium). One it missed
// would run as a unit beside the whole suite, as eight did until 2026-10-12. Here it fails at its first launch instead,
// naming itself. A vi.mock in a project's setupFiles applies to every test file of that project and to no other (seen
// with Vitest 5.0.3, 2026-10-12).
import { expect, vi } from "vitest";

vi.mock("playwright", async original => {
  const real = await original<typeof import("playwright")>();
  const refuse = () => {
    throw new Error(`${expect.getState().testPath ?? "this test file"} starts Chromium but runs in the units project: `
      + "vitest.config.ts counts a file as a Chromium test when it imports playwright, or a module under apps/web/test that does");
  };
  const starts = new Set<PropertyKey>(["launch", "launchPersistentContext", "launchServer", "connect", "connectOverCDP"]);
  const chromium = new Proxy(real.chromium, {
    get(target, key) {
      if (starts.has(key)) return refuse;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { ...real, chromium };
});
