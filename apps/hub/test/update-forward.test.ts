// `morndo update`, `morndo doctor` and `morndo install` through the hub (design §4.8, §10.3): the hub runs the
// updater's program with an argument list and no shell, before its own settings and database are read — these
// commands need neither, and a machine with no hub still updates and installs — and leaves with the updater's
// exit code. The scratch HOME has no install, so this is exactly a developer's checkout: a status that says so
// (exit 0) and a doctor that names it (exit 78).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateStatusSchema } from "@morndo/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const main = join(import.meta.dirname, "../src/main.ts");

let home = "";
beforeAll(() => { home = mkdtempSync(join(tmpdir(), "morndo-upd-")); });
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

const run = (...args: string[]) =>
  spawnSync(process.execPath, ["--no-warnings", main, ...args], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 30_000 });

describe("the hub runs the updater's program (§4.8)", () => {
  it("morndo update --status --json answers with the machine's status, exit 0, with no hub database read", () => {
    const r = run("update", "--status", "--json");
    expect(r.status, r.stderr).toBe(0);
    expect(UpdateStatusSchema.parse(JSON.parse(r.stdout))).toMatchObject({ installMethod: "checkout", current: null, staged: null });
  });

  it("morndo doctor on an install the updater did not make exits 78", () => {
    const r = run("doctor");
    expect(r.status, r.stderr).toBe(78);
    expect(r.stderr).toMatch(/checkout/);
  });

  it("morndo install is forwarded too, and answers before any hub runs: no tree, exit 65", () => {
    const r = run("install", "--role", "node");
    expect(r.status, r.stderr).toBe(65);
    expect(r.stderr).toMatch(/no app\/VERSION above it|does not run from an unpacked release tree/);
  });
});
