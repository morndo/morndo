// Check 2 of `morndo-keys lease` (T-340): the parent must be the claude binary, started with a --settings whose sandbox is
// on, fail-closed and denies the vault and the key files (caller-proof.ts). Each case here is one way it can be wrong.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeBinary, settingsProof, verifyClaudeParent, type ProcReader } from "../src/adapters/caller-proof.ts";
import { claudeSettings } from "../src/adapters/runtime-claude.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const DENIED = ["/node/home/vault", "/node/home/connections.db", "/node/home/identity"];
const plan = { lease: "l1", connection: "zai", ref: null, configDir: null, model: "m", effort: "low", workspace: "/w", deny: DENIED, reservation: 0, probe: true };
const good = (): Record<string, unknown> => JSON.parse(claudeSettings(plan, "ulimit -c 0; exec morndo-keys lease --connection zai")) as Record<string, unknown>;

// A fake /proc: the parent is pid 50 with this exe, command line and settings file.
function reader(over: { exe?: string | null; args?: string[] | null; files?: Record<string, string>; cwd?: string | null } = {}): ProcReader {
  return {
    exe: () => (over.exe === undefined ? "/real/claude" : over.exe),
    cmdline: () => (over.args === undefined ? ["/real/claude", "--settings", JSON.stringify(good())] : over.args),
    cwd: () => (over.cwd === undefined ? "/lane" : over.cwd),
    file: path => over.files?.[path] ?? null,
  };
}

function claudeAt(): string {
  const dir = mkdtempSync(join(tmpdir(), "morndo-proof-"));
  dirs.push(dir);
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "real-claude"), "");
  symlinkSync(join(dir, "real-claude"), join(dir, "bin", "claude"));
  return dir;
}

describe("the lease's caller proof (check 2)", () => {
  it("finds the claude binary by its real path, through PATH or as given", () => {
    const dir = claudeAt();
    expect(claudeBinary("claude", join(dir, "bin"))?.endsWith("real-claude")).toBe(true);
    expect(claudeBinary(join(dir, "bin", "claude"), undefined)?.endsWith("real-claude")).toBe(true);
    expect(claudeBinary("claude", join(dir, "nowhere"))).toBeNull();
  });

  it("admits a claude parent started with the sandbox settings the runtime writes", () => {
    const dir = claudeAt();
    const proof = verifyClaudeParent(50, join(dir, "real-claude"), undefined, DENIED, reader({ exe: join(dir, "real-claude") }));
    expect(proof, JSON.stringify(proof)).toEqual({ ok: true });
  });

  it("reads the settings from a file, absolute or relative to the parent's directory", () => {
    const dir = claudeAt();
    const exe = join(dir, "real-claude");
    const files = { "/lane/s.json": JSON.stringify(good()), "/abs/s.json": JSON.stringify(good()) };
    expect(verifyClaudeParent(50, exe, undefined, DENIED, reader({ exe, args: ["claude", "--settings", "/abs/s.json"], files })).ok).toBe(true);
    expect(verifyClaudeParent(50, exe, undefined, DENIED, reader({ exe, args: ["claude", "--settings=s.json"], files })).ok).toBe(true);
    expect(verifyClaudeParent(50, exe, undefined, DENIED, reader({ exe, args: ["claude", "--settings", "gone.json"], files })).ok).toBe(false);
  });

  it("refuses a parent that is not the claude binary, or has no readable command line", () => {
    const dir = claudeAt();
    const exe = join(dir, "real-claude");
    expect(verifyClaudeParent(50, exe, undefined, DENIED, reader({ exe: "/bin/dash" }))).toMatchObject({ ok: false, why: "parent is not claude" });
    expect(verifyClaudeParent(50, exe, undefined, DENIED, reader({ exe: null }))).toMatchObject({ ok: false });
    expect(verifyClaudeParent(50, exe, undefined, DENIED, reader({ exe, args: null }))).toMatchObject({ ok: false });
    expect(verifyClaudeParent(50, join(dir, "missing"), undefined, DENIED, reader({ exe }))).toMatchObject({ ok: false, why: "claude binary not found" });
  });

  it("refuses a claude started without --settings, or with two", () => {
    const dir = claudeAt();
    const exe = join(dir, "real-claude");
    expect(verifyClaudeParent(50, exe, undefined, DENIED, reader({ exe, args: ["claude", "-p"] }))).toMatchObject({ ok: false, why: "no --settings" });
    const one = JSON.stringify(good());
    expect(verifyClaudeParent(50, exe, undefined, DENIED, reader({ exe, args: ["claude", "--settings", one, "--settings", one] }))).toMatchObject({ ok: false, why: "more than one --settings" });
    expect(verifyClaudeParent(50, exe, undefined, DENIED, reader({ exe, args: ["claude", "--settings", "{not json"] }))).toMatchObject({ ok: false });
  });

  it("refuses a sandbox that is off, open on failure, or lets a command leave it", () => {
    for (const change of [{ enabled: false }, { failIfUnavailable: false }, { allowUnsandboxedCommands: true }, { enabled: undefined }]) {
      const settings = good();
      settings.sandbox = { ...(settings.sandbox as object), ...change };
      expect(settingsProof(settings, DENIED), JSON.stringify(change)).toMatchObject({ ok: false, why: "sandbox is not on and fail-closed" });
    }
    expect(settingsProof({}, DENIED).ok).toBe(false);
    expect(settingsProof(null, DENIED).ok).toBe(false);
  });

  it("refuses settings that leave the vault, the database or the identity readable, to Bash or to the Read tool", () => {
    for (const path of DENIED) {
      const noBash = good() as { sandbox: { filesystem: { denyRead: string[] } } };
      noBash.sandbox.filesystem.denyRead = noBash.sandbox.filesystem.denyRead.filter(entry => entry !== path);
      expect(settingsProof(noBash, DENIED), path).toMatchObject({ ok: false, why: `denyRead does not cover ${path}` });
      const noRead = good() as { permissions: { deny: string[] } };
      noRead.permissions.deny = noRead.permissions.deny.filter(rule => !rule.startsWith(`Read(//${path.slice(1)}`));
      expect(settingsProof(noRead, DENIED), path).toMatchObject({ ok: false, why: `Read is not denied for ${path}` });
    }
  });

  it("takes a directory above a path as covering it, and a lookalike prefix as not", () => {
    const above = good() as { sandbox: { filesystem: { denyRead: string[] } }; permissions: { deny: string[] } };
    above.sandbox.filesystem.denyRead = ["/node/home/"];
    above.permissions.deny = ["Read(//node/home/**)"];
    expect(settingsProof(above, DENIED).ok).toBe(true);
    above.sandbox.filesystem.denyRead = ["/node/hom"];
    expect(settingsProof(above, DENIED).ok).toBe(false);
  });
});
