// The command line (design §8.1, §8.3, §8.4, §10.2 step 1): what `morndo update --check`, `--status` and `morndo
// doctor` print and exit with, before anything touches the network. The refusals that come first are the ones the
// e2e leaves alone: TLS switched off, no HOME, a feed URL that is not https, a settings file that is not the wire's
// shape, and the settings step's words that arrive later. The deeper paths (a verified staging, every fault)
// are check-stage.e2e.test.ts's, against a real feed.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateStatusSchema } from "@morndo/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkCode, platformWord, runUpdater } from "../src/cli.ts";
import { CHECKOUT_SENTENCE } from "../src/application/check-service.ts";
import { wipe } from "./helpers/fakes.ts";

let scratch = "";
let home = "";

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "morndo-upd-"));
  home = join(scratch, "home");                 // a HOME with no install: a checkout, as far as the updater knows
  mkdirSync(home, { recursive: true, mode: 0o700 });
});
afterAll(() => { wipe(scratch); });

// One run of the program's entry, without a process around it.
const run = async (argv: string[], env: Record<string, string | undefined> = {}):
  Promise<{ code: number; out: string; err: string }> => {
  const out: string[] = [], err: string[] = [];
  const code = await runUpdater(argv, { HOME: home, PATH: process.env.PATH, ...env }, {
    out: s => out.push(s), err: s => err.push(s),
  });
  return { code, out: out.join(""), err: err.join("") };
};

const APPLIES_NOTHING = /arrive with the settings step/;

describe("the command line (§8.1, §8.4)", () => {
  // sysexits.h (§8.4): a refusal of the data is 65; anything that should simply be tried again later — the network,
  // a busy lock, an I/O error such as a full disk — is 75.
  it("exit codes: refused 65; failed, unreachable and busy 75; not ours 78; the rest 0", () => {
    expect(checkCode({ kind: "refused", step: "artifact_digest", detail: "x" })).toBe(65);
    expect(checkCode({ kind: "failed", detail: "disk full" })).toBe(75);
    expect(checkCode({ kind: "unreachable", detail: "x" })).toBe(75);
    expect(checkCode({ kind: "busy" })).toBe(75);
    expect(checkCode({ kind: "not_ours", detail: "x" })).toBe(78);
    expect(checkCode({ kind: "staged", version: "0.2.0", already: false })).toBe(0);
  });
  it("maps the machine to the platforms Morndo ships, and no other", () => {
    expect(platformWord("linux", "x64")).toBe("linux-x64");
    expect(platformWord("linux", "arm64")).toBe("linux-arm64");
    expect(platformWord("darwin", "arm64")).toBe("darwin-arm64");
    expect(platformWord("darwin", "x64")).toBe(null);
    expect(platformWord("win32", "x64")).toBe(null);
  });

  it("refuses to run with TLS checks off, before any command (§10.2 step 1)", async () => {
    for (const argv of [["update", "--check"], ["doctor"], ["update", "--status"]]) {
      const r = await run(argv, { NODE_TLS_REJECT_UNAUTHORIZED: "0" });
      expect(r.code).toBe(78);
      expect(r.err).toMatch(/NODE_TLS_REJECT_UNAUTHORIZED=0: TLS checks are off/);
    }
  });

  it("refuses a HOME that is unset or not absolute: every path derives from it (§5)", async () => {
    for (const bad of [undefined, "", "relative/home"]) {
      const out: string[] = [], err: string[] = [];
      const code = await runUpdater(["update", "--status"], { HOME: bad, PATH: process.env.PATH },
        { out: s => out.push(s), err: s => err.push(s) });
      expect(code).toBe(78);
      expect(err.join("")).toMatch(/HOME/);
    }
  });

  it("refuses a feed URL that is not https, and accepts one without its trailing slash (§8.3)", async () => {
    const bad = await run(["update", "--status"], { MORNDO_UPDATE_FEED: "http://mirror.example.invalid/morndo/" });
    expect(bad.code).toBe(78);
    expect(bad.err).toMatch(/MORNDO_UPDATE_FEED/);
    const good = await run(["update", "--status", "--json"], { MORNDO_UPDATE_FEED: "https://mirror.example.invalid/morndo" });
    expect(good.code, good.err).toBe(0);
  });

  it("a settings file that is not the wire's shape is one sentence and exit 78", async () => {
    const config = join(home, ".config/morndo-update/config.json");
    mkdirSync(join(config, ".."), { recursive: true });
    writeFileSync(config, "{ not json");
    const r = await run(["update", "--status"]);
    expect(r.code).toBe(78);
    expect(r.err).toMatch(/not JSON, so not the update settings/);
    rmSync(config);
  });

  it("usage: an unknown command, or update --check and --status together", async () => {
    for (const argv of [[], ["frob"], ["update", "--check", "--status"], ["doctor", "--frob"]]) {
      const r = await run(argv);
      expect(r.code, JSON.stringify(argv)).toBe(64);
      expect(r.err).toMatch(/usage/);
    }
  });

  it("the settings step's words — --to, --channel, pin, auto — are one sentence and exit 64 (§8.1)", async () => {
    for (const argv of [
      ["update", "--to", "0.2.0"], ["update", "--channel", "latest"], ["update", "pin", "0.2.0"], ["update", "auto", "apply"],
    ]) {
      const r = await run(argv);
      expect(r.code, JSON.stringify(argv)).toBe(64);
      expect(r.err, JSON.stringify(argv)).toMatch(APPLIES_NOTHING);
    }
  });

  it("the apply commands answer on a checkout as the check does: not_ours, exit 78 (RL14)", async () => {
    for (const argv of [["update"], ["update", "--now"], ["update", "--rollback"]]) {
      const r = await run(argv);
      expect(r.code, JSON.stringify(argv)).toBe(78);
      expect(r.err, JSON.stringify(argv)).toContain(CHECKOUT_SENTENCE);
    }
  });

  it("update --check on an install the updater did not make is not_ours, exit 78, in its own words (RL14)", async () => {
    const r = await run(["update", "--check"]);
    expect(r.code).toBe(78);
    expect(r.err).toContain(CHECKOUT_SENTENCE);
  });

  it("MORNDO_DISABLE_UPDATES=1 refuses the check for every install (§8.3, RL14)", async () => {
    const r = await run(["update", "--check"], { MORNDO_DISABLE_UPDATES: "1" });
    expect(r.code).toBe(78);
    expect(r.err).toMatch(/MORNDO_DISABLE_UPDATES/);
  });

  it("update --status prints a checkout's state and exits 0, json or text; --check's own json is one object", async () => {
    const text = await run(["update", "--status"]);
    expect(text.code, text.err).toBe(0);
    expect(text.out).toMatch(/install: checkout/);

    const json = await run(["update", "--status", "--json"]);
    expect(json.code, json.err).toBe(0);
    const status = UpdateStatusSchema.parse(JSON.parse(json.out));
    expect(status).toMatchObject({ installMethod: "checkout", current: null, staged: null, keySet: null });

    const outcome = await run(["update", "--check", "--json"], { MORNDO_DISABLE_UPDATES: "1" });
    expect(outcome.code).toBe(78);
    expect(JSON.parse(outcome.out)).toEqual({
      outcome: { kind: "not_ours", detail: "updates are disabled (MORNDO_DISABLE_UPDATES)" },
    });
  });

  it("doctor on a checkout names the install and exits 78, json or text", async () => {
    const text = await run(["doctor"]);
    expect(text.code).toBe(78);
    expect(text.err).toContain(CHECKOUT_SENTENCE);

    const json = await run(["doctor", "--json"]);
    expect(json.code).toBe(78);
    const report = JSON.parse(json.out) as { ok: boolean; findings: { area: string; detail: string }[] };
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([{ area: "install", detail: CHECKOUT_SENTENCE }]);
  });
});
