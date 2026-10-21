// Check 2 of `morndo-keys lease` (T-340): the parent must be the pinned claude binary, started with one --settings and an
// empty --setting-sources, whose sandbox is on, fail-closed, runs everything inside it and denies the vault and the key
// files, with a settings file unchanged since the parent started (caller-proof.ts). Each case is one way it can be wrong.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SANDBOX_WEAKENERS, parsePin, pinFor, settingsProof, sha256Of, verifyClaudeParent, type Pin, type ProcReader, type Wanted } from "../src/adapters/caller-proof.ts";
import { claudeSettings } from "../src/adapters/runtime-claude.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const DENIED = ["/node/cfg/vault", "/node/cfg/connections.db", "/node/cfg/identity"];
const WANT: Wanted = { denied: DENIED, writeProtected: [...DENIED, "/node/cfg/claude-pin.json"] };
const plan = { lease: "l1", connection: "zai", ref: null, configDir: null, model: "m", effort: "low", workspace: "/w", deny: DENIED, reservation: 0, probe: true };
const PIN: Pin = { path: "/bin/claude", resolved: "/real/claude/2.1.306", sha256: "a".repeat(64), size: 1000, mtimeMs: 5000, ino: 77 };
type Body = Record<string, any>;
const good = (): Body => JSON.parse(claudeSettings(plan, "ulimit -c 0; exec morndo-keys lease --connection zai")) as Body;
const START = 1_800_000_000_000;

type Fake = {
  exe?: string | null; args?: string[] | null; cwd?: string | null; started?: number | null;
  files?: Record<string, { body: string; mtimeMs: number; ctimeMs: number }>; links?: Record<string, string>;
  now?: { exe?: string | null; started?: number | null };       // what a second read of the parent answers
  identity?: { size: number; mtimeMs: number; ino: number } | null;   // the running binary's inode, as the pin has it by default
  sha?: string | null;                                                // its content hash, when it is asked for
  symlinked?: string[];                                               // paths that are, or go through, a symlink
  hashed?: { count: number };                                         // counts the reads of the binary's content
};
// A fake /proc: the parent is pid 50, a claude of the pinned version started at START with inline sandbox settings.
function reader(over: Fake = {}): ProcReader {
  let exeReads = 0;
  let tickReads = 0;
  return {
    exe: () => (++exeReads > 1 && over.now?.exe !== undefined ? over.now.exe : over.exe === undefined ? PIN.resolved : over.exe),
    cmdline: () => (over.args === undefined ? ["claude", "--strict-mcp-config", "--setting-sources", "", "--settings", JSON.stringify(good())] : over.args),
    cwd: () => (over.cwd === undefined ? "/lane" : over.cwd),
    startMs: () => (over.started === undefined ? START : over.started),
    ticks: () => (over.started === null ? null : ++tickReads > 1 && over.now?.started !== undefined ? over.now.started : 4242),
    file: path => over.files?.[path] ?? null,
    real: path => over.links?.[path] ?? path,
    linked: path => over.symlinked?.includes(path) ?? false,
    exeIdentity: () => (over.identity === undefined ? { size: PIN.size, mtimeMs: PIN.mtimeMs, ino: PIN.ino } : over.identity),
    exeSha256: () => { if (over.hashed) over.hashed.count++; return over.sha === undefined ? PIN.sha256 : over.sha; },
  };
}
const verify = (over: Fake = {}, pin: Pin | null = PIN, ppid: () => number = () => 50) => verifyClaudeParent({ ppid, pin, want: WANT, read: reader(over) });
const withSettings = (settings: Body, extra: string[] = []) => ["claude", "--strict-mcp-config", "--setting-sources", "", ...extra, "--settings", JSON.stringify(settings)];

describe("the lease's caller proof (check 2)", () => {
  it("admits the pinned claude, started with the sandbox settings the runtime writes and no other setting sources", () => {
    expect(verify()).toEqual({ ok: true });
    expect(verify({ args: ["claude", "--strict-mcp-config", "--setting-sources=", `--settings=${JSON.stringify(good())}`] })).toEqual({ ok: true });
  });

  it("refuses when nothing is pinned: the binary comes from the node's pin, never from the caller's environment", () => {
    expect(verify({}, null)).toMatchObject({ ok: false, why: "no pinned claude binary" });
  });

  it("refuses a parent that is not the pinned binary, or cannot be read", () => {
    expect(verify({ exe: "/bin/dash" })).toMatchObject({ ok: false, why: "parent is not the pinned claude" });
    expect(verify({ exe: "/tmp/fake-claude" })).toMatchObject({ ok: false, why: "parent is not the pinned claude" });
    expect(verify({ exe: null })).toMatchObject({ ok: false });
    expect(verify({ started: null })).toMatchObject({ ok: false });
    expect(verify({ args: null })).toMatchObject({ ok: false });
  });

  it("an update is a new file: refused until the owner pins it again", () => {
    expect(verify({ exe: "/real/claude/2.1.307", links: { "/bin/claude": "/real/claude/2.1.307" } })).toMatchObject({ ok: false, why: "parent is not the pinned claude" });
  });

  it("accepts a deleted binary only when it is the file that was pinned", () => {
    expect(verify({ exe: `${PIN.resolved} (deleted)` })).toEqual({ ok: true });
    expect(verify({ exe: "/real/claude/2.1.305 (deleted)" })).toMatchObject({ ok: false });
  });

  it("binds the pin to the file's content: the same inode is not read again, a changed one is hashed, a swapped one is refused", () => {
    const hashed = { count: 0 };
    expect(verify({ hashed })).toEqual({ ok: true });
    expect(hashed.count).toBe(0);                                                            // size, mtime and inode as pinned: no hash
    const touched = { size: PIN.size, mtimeMs: PIN.mtimeMs + 1, ino: PIN.ino };
    expect(verify({ identity: touched, hashed })).toEqual({ ok: true });                     // same bytes, new mtime: the hash says so
    expect(hashed.count).toBe(1);
    for (const identity of [{ ...touched, size: PIN.size + 1 }, { ...touched, ino: PIN.ino + 1 }, touched]) {
      expect(verify({ identity, sha: "b".repeat(64) }), JSON.stringify(identity)).toMatchObject({ ok: false, why: "the claude binary is not the one that was pinned" });
    }
    expect(verify({ identity: touched, sha: null })).toMatchObject({ ok: false });
    expect(verify({ identity: null })).toMatchObject({ ok: false });
  });

  it("requires --setting-sources with an empty value, once", () => {
    const settings = JSON.stringify(good());
    expect(verify({ args: ["claude", "--strict-mcp-config", "--settings", settings] })).toMatchObject({ ok: false, why: "setting sources are not limited to none" });
    expect(verify({ args: ["claude", "--strict-mcp-config", "--setting-sources", "user", "--settings", settings] })).toMatchObject({ ok: false });
    expect(verify({ args: ["claude", "--strict-mcp-config", "--setting-sources", "", "--setting-sources", "local", "--settings", settings] })).toMatchObject({ ok: false });
  });

  it("refuses a claude that may start MCP servers: --strict-mcp-config is required and --mcp-config is not allowed", () => {
    const settings = JSON.stringify(good());
    expect(verify({ args: ["claude", "--setting-sources", "", "--settings", settings] })).toMatchObject({ ok: false, why: "MCP servers are not limited to none" });
    expect(verify({ args: ["claude", "--strict-mcp-config", "--mcp-config", "./mcp.json", "--setting-sources", "", "--settings", settings] })).toMatchObject({ ok: false, why: "MCP servers are not limited to none" });
  });

  it("refuses a claude started without --settings, or with two", () => {
    const one = JSON.stringify(good());
    expect(verify({ args: ["claude", "--strict-mcp-config", "--setting-sources", ""] })).toMatchObject({ ok: false, why: "no --settings" });
    expect(verify({ args: ["claude", "--strict-mcp-config", "--setting-sources", "", "--settings", one, "--settings", one] })).toMatchObject({ ok: false, why: "more than one --settings" });
    expect(verify({ args: ["claude", "--strict-mcp-config", "--setting-sources", "", "--settings", "{not json"] })).toMatchObject({ ok: false });
  });

  it("reads a settings file, and refuses one that changed after the parent started or is not denied to writing", () => {
    const body = (change: (s: Body) => void = () => {}) => { const s = good(); s.sandbox.filesystem.denyWrite = ["/settings"]; change(s); return JSON.stringify(s); };
    const file = (text: string, mtimeMs = START - 1000, ctimeMs = START - 1000) => ({ "/settings/s.json": { body: text, mtimeMs, ctimeMs } });
    const args = ["claude", "--strict-mcp-config", "--setting-sources", "", "--settings", "/settings/s.json"];
    expect(verify({ args, files: file(body()) })).toEqual({ ok: true });
    expect(verify({ args: ["claude", "--strict-mcp-config", "--setting-sources", "", "--settings", "s.json"], cwd: "/settings", files: file(body()) })).toEqual({ ok: true });
    expect(verify({ args, files: file(body(), START + 5000) })).toMatchObject({ ok: false, why: "settings changed after the parent started" });
    expect(verify({ args, files: file(body(), START - 1000, START + 5000) })).toMatchObject({ ok: false, why: "settings changed after the parent started" });
    expect(verify({ args, files: file(body(), START + 15) })).toEqual({ ok: true });         // the clock's own grain
    expect(verify({ args, files: file(body(), START + 25) })).toMatchObject({ ok: false });
    expect(verify({ args, files: file(body(s => { s.sandbox.filesystem.denyWrite = []; })) })).toMatchObject({ ok: false, why: "the settings file is not denied to writing" });
    expect(verify({ args, files: file(body(s => { s.sandbox.filesystem.allowWrite = ["/settings"]; })) })).toMatchObject({ ok: false });
    expect(verify({ args, files: {} })).toMatchObject({ ok: false, why: "settings unreadable" });
  });

  it("refuses a sandbox that is off, open on failure, or lets a command leave it", () => {
    for (const change of [{ enabled: false }, { failIfUnavailable: false }, { allowUnsandboxedCommands: true }, { enabled: undefined }]) {
      const settings = good();
      settings.sandbox = { ...settings.sandbox, ...change };
      expect(settingsProof(settings, WANT), JSON.stringify(change)).toMatchObject({ ok: false, why: "sandbox is not on and fail-closed" });
    }
    expect(settingsProof({}, WANT).ok).toBe(false);
    expect(settingsProof(null, WANT).ok).toBe(false);
  });

  it("refuses commands that run outside the sandbox", () => {
    for (const excluded of [["git"], "git", {}]) {
      const settings = good();
      settings.sandbox.excludedCommands = excluded;
      expect(verify({ args: withSettings(settings) }), JSON.stringify(excluded)).toMatchObject({ ok: false, why: "commands may run outside the sandbox" });
    }
    const empty = good();
    empty.sandbox.excludedCommands = [];
    expect(verify({ args: withSettings(empty) })).toEqual({ ok: true });
  });

  it("refuses settings that leave the vault, the database or the identity readable, to Bash or to the Read tool", () => {
    for (const path of DENIED) {
      const noBash = good();
      noBash.sandbox.filesystem.denyRead = noBash.sandbox.filesystem.denyRead.filter((entry: string) => entry !== path);
      expect(settingsProof(noBash, WANT), path).toMatchObject({ ok: false, why: `denyRead does not cover ${path}` });
      const noRead = good();
      noRead.permissions.deny = noRead.permissions.deny.filter((rule: string) => !rule.startsWith(`Read(//${path.slice(1)}`));
      expect(settingsProof(noRead, WANT), path).toMatchObject({ ok: false, why: `Read is not denied for ${path}` });
    }
  });

  it("takes a directory above a path as covering it, and a lookalike prefix as not", () => {
    const above = good();
    above.sandbox.filesystem.denyRead = ["/node/cfg/"];
    above.permissions.deny = ["Read(//node/cfg/**)"];
    expect(settingsProof(above, WANT).ok).toBe(true);
    above.sandbox.filesystem.denyRead = ["/node/cf"];
    expect(settingsProof(above, WANT).ok).toBe(false);
  });

  it("refuses allowRead that re-opens the vault, the database or the identity, and allowWrite that opens them or the pin", () => {
    for (const reopen of ["/node/cfg", "/node/cfg/vault", "/node/cfg/vault/key-1", "/node/cfg/identity"]) {
      const settings = good();
      settings.sandbox.filesystem.allowRead = [reopen];
      expect(settingsProof(settings, WANT), reopen).toMatchObject({ ok: false });
    }
    for (const open of ["/node/cfg", "/node/cfg/claude-pin.json", "/node/cfg/vault"]) {
      const settings = good();
      settings.sandbox.filesystem.allowWrite = [open];
      expect(settingsProof(settings, WANT), open).toMatchObject({ ok: false });
    }
    const fine = good();
    fine.sandbox.filesystem.allowRead = ["/work/repo"];
    fine.sandbox.filesystem.allowWrite = ["/work/repo/.git"];
    expect(settingsProof(fine, WANT)).toEqual({ ok: true });
  });

  it("judges deny entries on real paths: a link to the vault is the vault, a link elsewhere is not", () => {
    const links = { "/node/cfg/vault": "/data/vault", "/node/cfg/connections.db": "/data/connections.db", "/node/cfg/identity": "/data/identity", "/alias/vault": "/data/vault" };
    const settings = good();
    settings.sandbox.filesystem.denyRead = ["/alias/vault", "/node/cfg/connections.db", "/node/cfg/identity"];
    settings.permissions.deny = ["Read(//data/vault/**)", "Read(//data/connections.db)", "Read(//data/identity)"];
    expect(settingsProof(settings, WANT, path => links[path as keyof typeof links] ?? path)).toEqual({ ok: true });
    settings.sandbox.filesystem.denyRead = ["/alias/other", "/node/cfg/connections.db", "/node/cfg/identity"];
    expect(settingsProof(settings, WANT, path => links[path as keyof typeof links] ?? path)).toMatchObject({ ok: false });
    settings.sandbox.filesystem.denyRead = ["/node/cfg/vault", "/node/cfg/connections.db", "/node/cfg/identity"];
    settings.sandbox.filesystem.allowRead = ["/alias/vault"];                                   // a link to the denied vault re-opens it
    expect(settingsProof(settings, WANT, path => links[path as keyof typeof links] ?? path)).toMatchObject({ ok: false });
  });

  it("refuses a parent that is not the process it was when the checks began", () => {
    let reads = 0;
    expect(verify({}, PIN, () => (++reads === 1 ? 50 : 1))).toMatchObject({ ok: false, why: "the parent changed while it was checked" });   // reparented
    expect(verify({ now: { started: START + 1 } })).toMatchObject({ ok: false, why: "the parent changed while it was checked" });          // another process under the pid
    expect(verify({ now: { exe: "/bin/dash" } })).toMatchObject({ ok: false, why: "the parent changed while it was checked" });
    expect(verify({}, PIN, () => 50)).toEqual({ ok: true });
  });

  it("refuses a settings path that is, or goes through, a symlink", () => {
    const args = ["claude", "--strict-mcp-config", "--setting-sources", "", "--settings", "/settings/s.json"];
    const s = good();
    s.sandbox.filesystem.denyWrite = ["/settings"];
    const files = { "/settings/s.json": { body: JSON.stringify(s), mtimeMs: START - 1000, ctimeMs: START - 1000 } };
    expect(verify({ args, files })).toEqual({ ok: true });
    expect(verify({ args, files, symlinked: ["/settings/s.json"] })).toMatchObject({ ok: false, why: "settings path goes through a symlink" });
  });

  it("refuses every known weakening of the sandbox, and takes the off values of them", () => {
    for (const path of SANDBOX_WEAKENERS) {
      const set = good();
      let node = set.sandbox;
      path.slice(0, -1).forEach(key => { node = node[key] ??= {}; });
      node[path.at(-1) as string] = path.at(-1) === "ignoreViolations" ? { "*": ["/x"] } : path.at(-1)?.startsWith("allowUnix") || path.at(-1) === "allowMachLookup" ? ["/x"] : true;
      expect(settingsProof(set, WANT), path.join(".")).toMatchObject({ ok: false, why: `sandbox weakened by ${path.join(".")}` });
      for (const off of [false, null, [], {}]) {
        const quiet = good();
        let at = quiet.sandbox;
        path.slice(0, -1).forEach(key => { at = at[key] ??= {}; });
        at[path.at(-1) as string] = off;
        expect(settingsProof(quiet, WANT), `${path.join(".")} = ${JSON.stringify(off)}`).toEqual({ ok: true });
      }
    }
    expect(SANDBOX_WEAKENERS.map(path => path.join("."))).toEqual(expect.arrayContaining(["enableWeakerNestedSandbox", "enableWeakerNetworkIsolation", "network.allowAllUnixSockets", "network.allowUnixSockets", "network.allowLocalBinding", "filesystem.disabled"]));
  });

  it("pins a binary by its real path, and reads a pin back", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-pin-"));
    dirs.push(dir);
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "real-claude"), "");
    symlinkSync(join(dir, "real-claude"), join(dir, "bin", "claude"));
    const pin = pinFor("claude", join(dir, "bin"));
    expect(pin?.path).toBe(join(dir, "bin", "claude"));
    expect(pin?.resolved.endsWith("real-claude")).toBe(true);
    expect(pin?.sha256).toBe(sha256Of(join(dir, "real-claude")));
    expect(pin).toMatchObject({ size: 0, ino: expect.any(Number), mtimeMs: expect.any(Number) });
    writeFileSync(join(dir, "real-claude"), "changed");
    expect(pinFor("claude", join(dir, "bin"))?.sha256).not.toBe(pin?.sha256);              // another content is another pin
    expect(sha256Of(join(dir, "nowhere"))).toBeNull();
    expect(pinFor(join(dir, "bin", "claude"), undefined)?.resolved.endsWith("real-claude")).toBe(true);
    expect(pinFor("claude", join(dir, "nowhere"))).toBeNull();
    expect(pinFor(dir, undefined)).toBeNull();                                                 // a directory is no binary
    expect(parsePin(JSON.stringify(pin))).toEqual(pin);
    expect(parsePin("not json")).toBeNull();
    expect(parsePin("{}")).toBeNull();
    expect(parsePin(JSON.stringify({ path: "/a", resolved: "/b" }))).toBeNull();            // a pin from before the content was bound
    expect(parsePin(null)).toBeNull();
  });
});
