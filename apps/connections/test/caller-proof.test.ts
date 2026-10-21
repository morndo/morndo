// Check 2 of `morndo-keys lease` (T-340): the parent must be the pinned claude binary, started with one --settings and an
// empty --setting-sources, whose sandbox is on, fail-closed, runs everything inside it and denies the vault and the key
// files, with a settings file unchanged since the parent started (caller-proof.ts). Each case is one way it can be wrong.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ALLOWED_SETTINGS, parseEnviron, parsePin, pinFor, settingsProof, sha256Of, verifyClaudeParent, type Pin, type ProcReader, type Wanted } from "../src/adapters/caller-proof.ts";
import { CLAUDE_RELEASE_FINGERPRINT } from "../src/adapters/claude-release-key.ts";
import { fileShaCache, type ReleasePin, type ShaCache } from "../src/adapters/release-manifest.ts";
import { claudeSettings } from "../src/adapters/runtime-claude.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const DENIED = ["/node/cfg/vault", "/node/cfg/connections.db", "/node/cfg/identity"];
const WANT: Wanted = { denied: DENIED, writeProtected: [...DENIED, "/node/cfg/claude-pin.json"] };
const plan = { lease: "l1", connection: "zai", ref: null, configDir: null, model: "m", effort: "low", workspace: "/w", deny: DENIED, reservation: 0, probe: true };
const BASE = "https://api.example.test/anthropic";
const PIN: Pin = { path: "/bin/claude", resolved: "/real/claude/2.1.306", sha256: "a".repeat(64), size: 1000, mtimeMs: 5000, ctimeMs: 6000, ino: 77, baseUrls: { zai: BASE } };
type Body = Record<string, any>;
// What a lane launcher passes: the runtime's settings without the credentials block, which a lane turn does not carry.
const good = (): Body => {
  const body = JSON.parse(claudeSettings(plan, "ulimit -c 0; exec morndo-keys lease --connection zai")) as Body;
  delete body.sandbox.credentials;
  return body;
};
const START = 1_800_000_000_000;

type Fake = {
  exe?: string | null; args?: string[] | null; cwd?: string | null; started?: number | null;
  files?: Record<string, { body: string; mtimeMs: number; ctimeMs: number }>; links?: Record<string, string>;
  now?: { exe?: string | null; started?: number | null };       // what a second read of the parent answers
  identity?: { size: number; mtimeMs: number; ctimeMs: number; ino: number } | null;   // the running binary's inode, as the pin has it by default
  sha?: string | null;                                                // its content hash, when it is asked for
  symlinked?: string[];                                               // paths that are, or go through, a symlink
  release?: ReleasePin | null;                                        // the signed releases the owner pinned
  verifyRelease?: (version: string, sha256: string) => Promise<{ ok: true } | { ok: false; why: string }>;   // the cache, as the lease asks it
  shaCache?: ShaCache;                                                // hashes already found in a signed manifest, by identity
  hashed?: { count: number };                                         // counts the reads of the binary's content
  env?: Record<string, string> | [string, string][] | null;          // the parent's environment (a list may name a variable twice)
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
    exeIdentity: () => (over.identity === undefined ? { size: PIN.size, mtimeMs: PIN.mtimeMs, ctimeMs: PIN.ctimeMs, ino: PIN.ino } : over.identity),
    environ: () => {
      const env = over.env === undefined ? { ANTHROPIC_BASE_URL: BASE, PATH: "/usr/bin" } : over.env;
      return env === null ? null : Array.isArray(env) ? env : Object.entries(env);
    },
    exeSha256: () => { if (over.hashed) over.hashed.count++; return over.sha === undefined ? PIN.sha256 : over.sha; },
  };
}
const verify = (over: Fake = {}, pin: Pin | null = PIN, ppid: () => number = () => 50) =>
  verifyClaudeParent({ ppid, pin, release: over.release ?? null, ...(over.verifyRelease === undefined ? {} : { verifyRelease: over.verifyRelease }), ...(over.shaCache === undefined ? {} : { shaCache: over.shaCache }), connection: "zai", want: WANT, read: reader(over) });

describe("the lease's caller proof (check 2)", () => {
  it("admits the pinned claude, started with the sandbox settings the runtime writes and no other setting sources", async () => {
    expect(await verify()).toEqual({ ok: true });
    expect(await verify({ args: ["claude", "--strict-mcp-config", "--setting-sources=", `--settings=${JSON.stringify(good())}`] })).toEqual({ ok: true });
  });

  it("refuses when nothing is pinned: the binary comes from the node's pin, never from the caller's environment", async () => {
    expect(await verify({}, null)).toMatchObject({ ok: false, why: "no pinned claude binary" });
  });

  it("refuses a parent that is not the pinned binary, or cannot be read", async () => {
    expect(await verify({ exe: "/bin/dash" })).toMatchObject({ ok: false, why: "parent is not the pinned claude" });
    expect(await verify({ exe: "/tmp/fake-claude" })).toMatchObject({ ok: false, why: "parent is not the pinned claude" });
    expect(await verify({ exe: null })).toMatchObject({ ok: false });
    expect(await verify({ started: null })).toMatchObject({ ok: false });
    expect(await verify({ args: null })).toMatchObject({ ok: false });
  });

  it("an update is a new file: refused until the owner pins it again", async () => {
    expect(await verify({ exe: "/real/claude/2.1.307", links: { "/bin/claude": "/real/claude/2.1.307" } })).toMatchObject({ ok: false, why: "parent is not the pinned claude" });
  });

  it("accepts a deleted binary only when it is the file that was pinned", async () => {
    expect(await verify({ exe: `${PIN.resolved} (deleted)` })).toEqual({ ok: true });
    expect(await verify({ exe: "/real/claude/2.1.305 (deleted)" })).toMatchObject({ ok: false });
  });

  it("binds the pin to the file's content: the same inode is not read again, a changed one is hashed, a swapped one is refused", async () => {
    const hashed = { count: 0 };
    expect(await verify({ hashed })).toEqual({ ok: true });
    expect(hashed.count).toBe(0);                                                            // size, mtime and inode as pinned: no hash
    const touched = { size: PIN.size, mtimeMs: PIN.mtimeMs + 1, ctimeMs: PIN.ctimeMs, ino: PIN.ino };
    expect(await verify({ identity: touched, hashed })).toEqual({ ok: true });                     // same bytes, new mtime: the hash says so
    expect(hashed.count).toBe(1);
    // utimes can put an old mtime back on a changed file, but not the ctime: a moved ctime sends it to the hash too
    const reset = { ...touched, mtimeMs: PIN.mtimeMs, ctimeMs: PIN.ctimeMs + 9 };
    expect(await verify({ identity: reset, hashed })).toEqual({ ok: true });
    expect(hashed.count).toBe(2);
    expect(await verify({ identity: reset, sha: "b".repeat(64) })).toMatchObject({ ok: false, why: "the claude binary is not the one that was pinned" });
    for (const identity of [{ ...touched, size: PIN.size + 1 }, { ...touched, ino: PIN.ino + 1 }, touched]) {
      expect(await verify({ identity, sha: "b".repeat(64) }), JSON.stringify(identity)).toMatchObject({ ok: false, why: "the claude binary is not the one that was pinned" });
    }
    expect(await verify({ identity: touched, sha: null })).toMatchObject({ ok: false });
    expect(await verify({ identity: null })).toMatchObject({ ok: false });
  });

  it("requires --setting-sources with an empty value, once", async () => {
    const settings = JSON.stringify(good());
    expect(await verify({ args: ["claude", "--strict-mcp-config", "--settings", settings] })).toMatchObject({ ok: false, why: "setting sources are not limited to none" });
    expect(await verify({ args: ["claude", "--strict-mcp-config", "--setting-sources", "user", "--settings", settings] })).toMatchObject({ ok: false });
    expect(await verify({ args: ["claude", "--strict-mcp-config", "--setting-sources", "", "--setting-sources", "local", "--settings", settings] })).toMatchObject({ ok: false });
  });

  it("refuses a claude that may start MCP servers: --strict-mcp-config is required and --mcp-config is not allowed", async () => {
    const settings = JSON.stringify(good());
    expect(await verify({ args: ["claude", "--setting-sources", "", "--settings", settings] })).toMatchObject({ ok: false, why: "MCP servers are not limited to none" });
    expect(await verify({ args: ["claude", "--strict-mcp-config", "--mcp-config", "./mcp.json", "--setting-sources", "", "--settings", settings] })).toMatchObject({ ok: false, why: "MCP servers are not limited to none" });
  });

  it("refuses a claude started without --settings, or with two", async () => {
    const one = JSON.stringify(good());
    expect(await verify({ args: ["claude", "--strict-mcp-config", "--setting-sources", ""] })).toMatchObject({ ok: false, why: "no --settings" });
    expect(await verify({ args: ["claude", "--strict-mcp-config", "--setting-sources", "", "--settings", one, "--settings", one] })).toMatchObject({ ok: false, why: "more than one --settings" });
    expect(await verify({ args: ["claude", "--strict-mcp-config", "--setting-sources", "", "--settings", "{not json"] })).toMatchObject({ ok: false });
  });

  it("reads a settings file, and refuses one that changed after the parent started or is not denied to writing", async () => {
    const body = (change: (s: Body) => void = () => {}) => { const s = good(); s.sandbox.filesystem.denyWrite = ["/settings"]; change(s); return JSON.stringify(s); };
    const file = (text: string, mtimeMs = START - 1000, ctimeMs = START - 1000) => ({ "/settings/s.json": { body: text, mtimeMs, ctimeMs } });
    const args = ["claude", "--strict-mcp-config", "--setting-sources", "", "--settings", "/settings/s.json"];
    expect(await verify({ args, files: file(body()) })).toEqual({ ok: true });
    expect(await verify({ args: ["claude", "--strict-mcp-config", "--setting-sources", "", "--settings", "s.json"], cwd: "/settings", files: file(body()) })).toEqual({ ok: true });
    expect(await verify({ args, files: file(body(), START + 5000) })).toMatchObject({ ok: false, why: "settings changed after the parent started" });
    expect(await verify({ args, files: file(body(), START - 1000, START + 5000) })).toMatchObject({ ok: false, why: "settings changed after the parent started" });
    expect(await verify({ args, files: file(body(), START + 15) })).toEqual({ ok: true });         // the clock's own grain
    expect(await verify({ args, files: file(body(), START + 25) })).toMatchObject({ ok: false });
    expect(await verify({ args, files: file(body(s => { s.sandbox.filesystem.denyWrite = []; })) })).toMatchObject({ ok: false, why: "the settings file is not denied to writing" });
    expect(await verify({ args, files: file(body(s => { s.sandbox.filesystem.allowWrite = ["/settings"]; })) })).toMatchObject({ ok: false });
    expect(await verify({ args, files: {} })).toMatchObject({ ok: false, why: "settings unreadable" });
  });

  it("refuses a sandbox that is off, open on failure, or lets a command leave it", async () => {
    for (const change of [{ enabled: false }, { failIfUnavailable: false }, { allowUnsandboxedCommands: true }, { enabled: undefined }]) {
      const settings = good();
      settings.sandbox = { ...settings.sandbox, ...change };
      expect(settingsProof(settings, WANT), JSON.stringify(change)).toMatchObject({ ok: false, why: "sandbox is not on and fail-closed" });
    }
    expect(settingsProof({}, WANT).ok).toBe(false);
    expect(settingsProof(null, WANT).ok).toBe(false);
  });

  it("refuses settings that leave the vault, the database or the identity readable, to Bash or to the Read tool", async () => {
    for (const path of DENIED) {
      const noBash = good();
      noBash.sandbox.filesystem.denyRead = noBash.sandbox.filesystem.denyRead.filter((entry: string) => entry !== path);
      expect(settingsProof(noBash, WANT), path).toMatchObject({ ok: false, why: `denyRead does not cover ${path}` });
      const noRead = good();
      noRead.permissions.deny = noRead.permissions.deny.filter((rule: string) => !rule.startsWith(`Read(//${path.slice(1)}`));
      expect(settingsProof(noRead, WANT), path).toMatchObject({ ok: false, why: `Read is not denied for ${path}` });
    }
  });

  it("takes a directory above a path as covering it, and a lookalike prefix as not", async () => {
    const above = good();
    above.sandbox.filesystem.denyRead = ["/node/cfg/"];
    above.permissions.deny = ["Read(//node/cfg/**)"];
    expect(settingsProof(above, WANT).ok).toBe(true);
    above.sandbox.filesystem.denyRead = ["/node/cf"];
    expect(settingsProof(above, WANT).ok).toBe(false);
  });

  it("refuses allowWrite that opens the vault, the database, the identity or the pin", async () => {
    for (const open of ["/node/cfg", "/node/cfg/claude-pin.json", "/node/cfg/vault"]) {
      const settings = good();
      settings.sandbox.filesystem.allowWrite = [open];
      expect(settingsProof(settings, WANT), open).toMatchObject({ ok: false });
    }
    const fine = good();
    fine.sandbox.filesystem.allowWrite = ["/work/repo/.git"];
    expect(settingsProof(fine, WANT)).toEqual({ ok: true });
  });

  it("refuses a parent whose environment can put another party on the line: a proxy, an extra CA, TLS checks off", async () => {
    const base = { ANTHROPIC_BASE_URL: BASE, PATH: "/usr/bin" };
    const families: Record<string, Record<string, string>[]> = {
      proxy: [{ HTTPS_PROXY: "http://127.0.0.1:3128" }, { https_proxy: "http://127.0.0.1:3128" }, { HTTP_PROXY: "http://127.0.0.1:3128" }, { Http_Proxy: "x" }, { ALL_PROXY: "socks5://127.0.0.1:1080" }, { all_proxy: "socks5://127.0.0.1:1080" }],
      ca: [{ NODE_EXTRA_CA_CERTS: "/tmp/ca.pem" }, { SSL_CERT_FILE: "/tmp/ca.pem" }, { SSL_CERT_DIR: "/tmp/certs" }],
      tls: [{ NODE_TLS_REJECT_UNAUTHORIZED: "0" }],
    };
    for (const [family, envs] of Object.entries(families)) {
      for (const extra of envs) {
        expect(await verify({ env: { ...base, ...extra } }), `${family}: ${JSON.stringify(extra)}`).toMatchObject({ ok: false, why: expect.stringContaining(Object.keys(extra)[0] as string) });
      }
    }
    expect(await verify({ env: { ...base, NODE_TLS_REJECT_UNAUTHORIZED: "1" } })).toEqual({ ok: true });   // Node's own default is not a switch
    expect(await verify({ env: { ...base, NO_PROXY: "localhost", HTTPS_PROXY_NOTE: "x" } })).toEqual({ ok: true });   // not a proxy, and no lookalike counts
  });

  it("refuses a checked name that the parent's environment holds twice, even with the same value", async () => {
    const twice = (name: string, first: string, second: string): [string, string][] => [["PATH", "/usr/bin"], ["ANTHROPIC_BASE_URL", BASE], [name, first], [name, second]];
    for (const name of ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_TLS_REJECT_UNAUTHORIZED"]) {
      expect(await verify({ env: twice(name, "1", "1") }), name).toMatchObject({ ok: false, why: `the parent's environment names ${name} twice` });
    }
    const base: [string, string][] = [["ANTHROPIC_BASE_URL", BASE], ["ANTHROPIC_BASE_URL", BASE]];
    expect(await verify({ env: base })).toMatchObject({ ok: false, why: "the parent's environment names ANTHROPIC_BASE_URL twice" });
    expect(await verify({ env: [["ANTHROPIC_BASE_URL", "https://elsewhere.example.test"], ["ANTHROPIC_BASE_URL", BASE]] })).toMatchObject({ ok: false });
    expect(await verify({ env: [["ANTHROPIC_BASE_URL", BASE], ["PATH", "/a"], ["PATH", "/b"]] })).toEqual({ ok: true });   // a name that is not checked may repeat
  });

  it("reads /proc's environ entry by entry, repeats included", async () => {
    expect(parseEnviron("A=1\0B=2=3\0A=4\0")).toEqual([["A", "1"], ["B", "2=3"], ["A", "4"]]);
    expect(parseEnviron("")).toEqual([]);
    expect(parseEnviron("=x\0noequals\0C=\0")).toEqual([["C", ""]]);
  });

  it("takes the parent's API host from its own environment, pinned for the connection, never from the lease's", async () => {
    expect(await verify({ env: { ANTHROPIC_BASE_URL: `${BASE}/` } })).toEqual({ ok: true });                 // a trailing slash is the same place
    expect(await verify({ env: { ANTHROPIC_BASE_URL: "HTTPS://API.EXAMPLE.TEST/anthropic" } })).toEqual({ ok: true });
    for (const env of [{ ANTHROPIC_BASE_URL: "https://elsewhere.example.test/anthropic" }, { ANTHROPIC_BASE_URL: "https://api.example.test/other" }, { ANTHROPIC_BASE_URL: "http://api.example.test/anthropic" }, { ANTHROPIC_BASE_URL: "https://api.example.test.evil.test/anthropic" }, { ANTHROPIC_BASE_URL: "not a url" }, { PATH: "/usr/bin" }, null]) {
      expect(await verify({ env }), JSON.stringify(env)).toMatchObject({ ok: false, why: "the parent is not pointed at the pinned API host" });
    }
    const unpinned = await verifyClaudeParent({ ppid: () => 50, pin: PIN, release: null, connection: "other", want: WANT, read: reader() });   // a connection added after the pin
    expect(unpinned).toMatchObject({ ok: false, why: "the parent is not pointed at the pinned API host" });
  });

  it("judges deny entries on real paths: a link to the vault is the vault, a link elsewhere is not", async () => {
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

  it("refuses a parent that is not the process it was when the checks began", async () => {
    let reads = 0;
    expect(await verify({}, PIN, () => (++reads === 1 ? 50 : 1))).toMatchObject({ ok: false, why: "the parent changed while it was checked" });   // reparented
    expect(await verify({ now: { started: START + 1 } })).toMatchObject({ ok: false, why: "the parent changed while it was checked" });          // another process under the pid
    expect(await verify({ now: { exe: "/bin/dash" } })).toMatchObject({ ok: false, why: "the parent changed while it was checked" });
    expect(await verify({}, PIN, () => 50)).toEqual({ ok: true });
  });

  it("refuses a settings path that is, or goes through, a symlink", async () => {
    const args = ["claude", "--strict-mcp-config", "--setting-sources", "", "--settings", "/settings/s.json"];
    const s = good();
    s.sandbox.filesystem.denyWrite = ["/settings"];
    const files = { "/settings/s.json": { body: JSON.stringify(s), mtimeMs: START - 1000, ctimeMs: START - 1000 } };
    expect(await verify({ args, files })).toEqual({ ok: true });
    expect(await verify({ args, files, symlinked: ["/settings/s.json"] })).toMatchObject({ ok: false, why: "settings path goes through a symlink" });
  });

  it("takes only the settings keys a lane turn may carry, and refuses anything else, set or not", async () => {
    // what the lane launcher (agent-engines glm-turn) and `morndo-keys run` both put in --settings
    const lane = good();
    lane.sandbox.network = { allowedDomains: ["api.example.test"] };
    lane.sandbox.filesystem.allowWrite = ["/work/repo/.git"];
    lane.sandbox.filesystem.denyWrite = ["/work/repo/.git/hooks"];
    expect(settingsProof(lane, WANT)).toEqual({ ok: true });
    // every key of the sandbox that weakens it (docs: https://code.claude.com/docs/en/sandboxing, read 2026-10-21), and the
    // ones a denylist would have missed: a proxy, hooks, env, a model endpoint, apiKeyHelper's neighbours
    const extras: [string[], unknown][] = [
      [["sandbox", "enableWeakerNestedSandbox"], true], [["sandbox", "enableWeakerNetworkIsolation"], true], [["sandbox", "allowAppleEvents"], true],
      [["sandbox", "ignoreViolations"], { "*": ["/x"] }], [["sandbox", "filesystem", "disabled"], true],
      [["sandbox", "network", "allowAllUnixSockets"], true], [["sandbox", "network", "allowUnixSockets"], ["/x"]],
      [["sandbox", "network", "allowLocalBinding"], true], [["sandbox", "network", "allowMachLookup"], ["x"]],
      [["sandbox", "network", "httpProxyPort"], 8080], [["sandbox", "network", "socksProxyPort"], 1080],
      [["sandbox", "network", "tlsTerminate"], true], [["sandbox", "credentials", "files"], []], [["sandbox", "autoAllowBashIfSandboxed"], true],
      [["hooks"], { Stop: [] }], [["env"], { ANTHROPIC_BASE_URL: "https://elsewhere.example.test" }], [["model"], "m"],
      [["permissions", "allow"], ["Read(//x)"]], [["permissions", "defaultMode"], "bypassPermissions"], [["statusLine"], { type: "command" }],
      [["enableAllProjectMcpServers"], true], [["apiBaseUrl"], "https://elsewhere.example.test"],
      [["enabledPlugins"], { "x@y": true }], [["permissions", "additionalDirectories"], ["/x"]], [["sandbox", "excludedCommands"], []],
      [["sandbox", "filesystem", "allowRead"], ["/x"]], [["sandbox", "credentials"], { envVars: [] }],
    ];
    for (const [path, value] of extras) {
      const set = good();
      let node: Body = set;
      path.slice(0, -1).forEach(key => { node = node[key] ??= {}; });
      node[path.at(-1) as string] = value;
      // refused at the first key the allowlist does not name: the key itself, or the branch that holds it
      const refused = settingsProof(set, WANT);
      const named = refused.ok ? null : /^settings key (\S+) is not one a lane turn may carry$/.exec(refused.why)?.[1];
      expect(named, path.join(".")).toBeTruthy();
      expect(path.join(".").startsWith(named ?? "\0"), path.join(".")).toBe(true);
      node[path.at(-1) as string] = false;                                                       // an off value is still an unknown key
      expect(settingsProof(set, WANT).ok, `${path.join(".")} = false`).toBe(false);
    }
    expect(ALLOWED_SETTINGS).toMatchObject({ apiKeyHelper: true, permissions: { deny: true }, sandbox: { enabled: true, filesystem: { denyRead: true }, network: { allowedDomains: true } } });
  });

  describe("signed releases (T-346)", () => {
    const RELEASE: ReleasePin = { fingerprint: CLAUDE_RELEASE_FINGERPRINT, versionsDir: "/versions", floor: "2.1.300", baseUrls: { zai: BASE } };
    const GOOD_SHA = PIN.sha256;
    // the cache's answer: the manifest of that version lists this sha256 (the fake reader's binary has PIN.sha256)
    const calls: [string, string][] = [];
    const cache = async (version: string, sha256: string): Promise<{ ok: true } | { ok: false; why: string }> => {
      calls.push([version, sha256]);
      return sha256 === GOOD_SHA ? { ok: true } : { ok: false, why: "the binary's sha256 is not in the signed manifest" };
    };
    const signed = (over: Fake = {}, pin: Pin | null = null) => verify({ exe: "/versions/2.1.306", release: RELEASE, verifyRelease: cache, ...over }, pin);

    it("admits a binary in the pinned directory, at or above the floor, that a signed manifest lists; the update needs no new pin", async () => {
      calls.length = 0;
      expect(await signed()).toEqual({ ok: true });
      expect(calls).toEqual([["2.1.306", GOOD_SHA]]);                                     // the version from the file's name, the hash of the running inode
      expect(await signed({ exe: "/versions/2.1.307" })).toEqual({ ok: true });              // the next day's release, same pin
      expect(await signed({ exe: "/versions/2.1.300" })).toEqual({ ok: true });              // the floor itself
      expect(await signed({ exe: "/versions/2.1.305 (deleted)" })).toEqual({ ok: true });    // an older one still running after an update removed it
    });

    it("refuses what the cache refuses: a checksum no signed manifest lists, a bad signature, no cached manifest", async () => {
      for (const why of ["the binary's sha256 is not in the signed manifest", "the manifest signature is not good", "no cached manifest for that version"]) {
        expect(await signed({ verifyRelease: async () => ({ ok: false, why }) })).toMatchObject({ ok: false, why });
      }
      expect(await signed({ sha: "e".repeat(64) })).toMatchObject({ ok: false, why: "the binary's sha256 is not in the signed manifest" });
      expect(await signed({ sha: null })).toMatchObject({ ok: false });
      expect(await signed({ verifyRelease: undefined as never })).toMatchObject({ ok: false });
    });

    it("refuses a binary outside the pinned directory, one that is not named by a version, and one below the floor", async () => {
      for (const exe of ["/opt/claude/2.1.306", "/versions/sub/2.1.306", "/tmp/versions/2.1.306", "/versions/claude", "/versions/2.1.306.bak", "/versions/2.1.299", "/versions/2.0.999"]) {
        expect(await signed({ exe }), exe).toMatchObject({ ok: false });
      }
      expect(await signed({ exe: "/versions/2.1.299" })).toMatchObject({ ok: false, why: "the parent binary is not a release at or above the pinned floor" });
      expect(await signed({ exe: "/opt/claude/2.1.306" })).toMatchObject({ ok: false, why: "the parent binary is outside the pinned releases directory" });
    });

    it("takes the directory by its real path, and refuses a pin whose key is not the compiled-in one", async () => {
      expect(await signed({ exe: "/real/versions/2.1.306", links: { "/versions": "/real/versions" } })).toEqual({ ok: true });
      expect(await signed({ exe: "/real/versions/2.1.306", links: { "/versions": "/elsewhere" } })).toMatchObject({ ok: false });
      expect(await verify({ exe: "/versions/2.1.306", release: { ...RELEASE, fingerprint: "0".repeat(40) }, verifyRelease: cache })).toMatchObject({ ok: false, why: "the pinned release key is not the compiled-in one" });
    });

    it("keeps every other check: the parent's API host, its settings and its environment still decide", async () => {
      expect(await signed({ env: { ANTHROPIC_BASE_URL: "https://elsewhere.example.test/anthropic" } })).toMatchObject({ ok: false, why: "the parent is not pointed at the pinned API host" });
      expect(await signed({ env: { ANTHROPIC_BASE_URL: BASE, HTTPS_PROXY: "http://127.0.0.1:3128" } })).toMatchObject({ ok: false });
      expect(await signed({ args: ["claude", "--strict-mcp-config", "--settings", "{}"] })).toMatchObject({ ok: false });
      expect(await signed({ now: { exe: "/versions/2.1.307" } })).toMatchObject({ ok: false, why: "the parent changed while it was checked" });
      expect(await verify({ exe: "/versions/2.1.306", release: { ...RELEASE, baseUrls: {} }, verifyRelease: cache })).toMatchObject({ ok: false });   // no host pinned for the connection
    });

    it("hashes a release binary once: the next lease with the same identity takes the hash from the cache, and still checks the manifest", async () => {
      const dir = mkdtempSync(join(tmpdir(), "morndo-sha-"));
      dirs.push(dir);
      const shaCache = fileShaCache(dir);
      const hashed = { count: 0 };
      calls.length = 0;
      expect(await signed({ shaCache, hashed })).toEqual({ ok: true });
      expect(hashed.count).toBe(1);
      expect(await signed({ shaCache, hashed })).toEqual({ ok: true });                       // a new process, the same file: no hash
      expect(hashed.count).toBe(1);
      expect(calls).toEqual([["2.1.306", GOOD_SHA], ["2.1.306", GOOD_SHA]]);                   // the manifest was asked each time
      // the manifest decides, whatever the cache holds: a cached hash that a manifest no longer lists is refused
      expect(await signed({ shaCache, hashed, verifyRelease: async () => ({ ok: false, why: "no cached manifest for that version" }) })).toMatchObject({ ok: false });
      expect(hashed.count).toBe(1);
    });

    it("hashes again when the file is not the one that was hashed: a new ctime, mtime, size or inode, or another path", async () => {
      const dir = mkdtempSync(join(tmpdir(), "morndo-sha-"));
      dirs.push(dir);
      const shaCache = fileShaCache(dir);
      const hashed = { count: 0 };
      const same = { size: PIN.size, mtimeMs: PIN.mtimeMs, ctimeMs: PIN.ctimeMs, ino: PIN.ino };
      await signed({ shaCache, hashed, identity: same });
      expect(hashed.count).toBe(1);
      let expected = 1;
      for (const [what, identity, exe] of [
        ["ctime", { ...same, ctimeMs: same.ctimeMs + 1 }, undefined], ["mtime", { ...same, mtimeMs: same.mtimeMs + 1 }, undefined],
        ["size", { ...same, size: same.size + 1 }, undefined], ["inode", { ...same, ino: same.ino + 1 }, undefined], ["path", same, "/versions/2.1.307"],
      ] as const) {
        expect(await signed({ shaCache, hashed, identity, ...(exe === undefined ? {} : { exe }) }), what).toEqual({ ok: true });
        expect(hashed.count, what).toBe(++expected);
      }
      expect(await signed({ shaCache, hashed, identity: same })).toEqual({ ok: true });       // the entry kept for this path is the inode+1 file's: this one hashes
      expect(hashed.count).toBe(expected + 1);
    });

    it("never caches a hash a signed manifest did not list", async () => {
      const dir = mkdtempSync(join(tmpdir(), "morndo-sha-"));
      dirs.push(dir);
      const shaCache = fileShaCache(dir);
      const hashed = { count: 0 };
      expect(await signed({ shaCache, hashed, sha: "e".repeat(64) })).toMatchObject({ ok: false });
      expect(await signed({ shaCache, hashed, sha: "e".repeat(64) })).toMatchObject({ ok: false });
      expect(hashed.count).toBe(2);                                                           // not remembered: hashed both times
      expect(shaCache.get("/versions/2.1.306", { size: PIN.size, mtimeMs: PIN.mtimeMs, ctimeMs: PIN.ctimeMs, ino: PIN.ino })).toBeNull();
    });

    it("admits either proof: a release that is not admitted still passes on the binary pin, and neither pin refuses", async () => {
      expect(await verify({ exe: PIN.resolved, release: RELEASE, verifyRelease: cache })).toEqual({ ok: true });             // outside the directory, but the pinned file
      expect(await signed({ verifyRelease: async () => ({ ok: false, why: "no cached manifest for that version" }), exe: PIN.resolved }, PIN)).toEqual({ ok: true });
      expect(await verify({ exe: "/opt/x", release: RELEASE, verifyRelease: cache }, PIN)).toMatchObject({ ok: false });
      expect(await verify({}, null)).toMatchObject({ ok: false, why: "no pinned claude binary" });
    });
  });

  it("pins a binary by its real path, and reads a pin back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-pin-"));
    dirs.push(dir);
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "real-claude"), "");
    symlinkSync(join(dir, "real-claude"), join(dir, "bin", "claude"));
    const pin = pinFor("claude", join(dir, "bin"));
    expect(pin?.path).toBe(join(dir, "bin", "claude"));
    expect(pin?.resolved.endsWith("real-claude")).toBe(true);
    expect(pin?.sha256).toBe(sha256Of(join(dir, "real-claude")));
    expect(pin).toMatchObject({ size: 0, ino: expect.any(Number), mtimeMs: expect.any(Number), ctimeMs: expect.any(Number) });
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
    expect(parsePin(JSON.stringify({ path: "/a", resolved: "/b", sha256: "c", size: 1, mtimeMs: 2, ino: 3 }))).toBeNull();   // and one with no ctime
    expect(parsePin(JSON.stringify({ path: "/a", resolved: "/b", sha256: "c", size: 1, mtimeMs: 2, ctimeMs: 2, ino: 3 }))).toBeNull();   // or no hosts
    expect(parsePin(JSON.stringify({ ...PIN, baseUrls: { zai: 5 } }))).toBeNull();
    expect(parsePin(null)).toBeNull();
  });
});
