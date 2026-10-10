// confine(): which file on this machine may be read for someone else, by the rules the hub's copies use (files.ts),
// plus a node policy's roots. Synthetic files in a temporary directory only.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMITS } from "@morndo/protocol";
import { MAX_FILE_BYTES, confine, deniedBy, denyConfigWithClaudeDir, denyRoots, openConfined, openNoFollow, type DenyConfig } from "../src/file-rules.ts";

let root: string, home: string, data: string, work: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "morndo-confine-"));
  home = join(root, "home"); data = join(root, "data"); work = join(root, "work");
  for (const d of [home, join(home, ".ssh"), data, work]) mkdirSync(d, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const rules = () => ({ home, dataDir: data });

describe("confine", () => {
  it("allows a plain file: its real path and size", () => {
    writeFileSync(join(work, "shot.png"), "png-bytes");
    expect(confine(join(work, "shot.png"), rules())).toEqual({ ok: true, real: realpathSync(join(work, "shot.png")), size: 9 });
  });
  it("refuses what the hub's copies refuse, each with its reason", () => {
    writeFileSync(join(home, ".ssh", "id_ed25519"), "key");
    writeFileSync(join(home, ".ssh", "config"), "Host x");
    writeFileSync(join(work, ".env"), "TOKEN=x");
    writeFileSync(join(work, "server.pem"), "pem");
    writeFileSync(join(data, "agent.db"), "db");
    symlinkSync(join(home, ".ssh", "id_ed25519"), join(work, "innocent.png"));
    writeFileSync(join(work, "big.bin"), "");
    truncateSync(join(work, "big.bin"), MAX_FILE_BYTES + 1);                  // sparse: no 25 MiB written
    const reason = (p: string) => { const r = confine(p, rules()); return r.ok ? "ok" : r.reason; };
    expect(reason(join(home, ".ssh", "id_ed25519"))).toBe("secret");
    expect(reason(join(home, ".ssh", "config"))).toBe("denied");
    expect(reason(join(work, ".env"))).toBe("secret");
    expect(reason(join(work, "server.pem"))).toBe("secret");
    expect(reason(join(data, "agent.db"))).toBe("denied");
    expect(reason(join(work, "innocent.png"))).toBe("secret");                // a link: its target's name counts
    expect(reason(join(work, "big.bin"))).toBe("too_large");
    expect(reason(work)).toBe("not_file");
    expect(reason(join(work, "missing.png"))).toBe("missing");
    expect(reason("work/shot.png")).toBe("denied");                           // a relative path: never resolved against our cwd
    expect(reason("/etc/hosts")).toBe("denied");
    expect(reason(`${home}/x/../.ssh/absent`)).toBe("denied");               // judged before the disk: "missing" would tell
    writeFileSync(join(work, "ok.txt"), "fine");
    expect(reason(join(work, "ok.txt"))).toBe("ok");                         // negative control: a plain file passes
  });
  it("a file exactly at the cap passes; the cap is the fleet's file limit", () => {
    expect(MAX_FILE_BYTES).toBe(LIMITS.maxFileBytes);
    writeFileSync(join(work, "cap.bin"), "");
    truncateSync(join(work, "cap.bin"), MAX_FILE_BYTES);
    expect(confine(join(work, "cap.bin"), rules())).toMatchObject({ ok: true, size: MAX_FILE_BYTES });
  });
  it("a link into a deny root is refused even when the home itself sits behind a link", () => {
    const realHome = join(root, "real-home");
    mkdirSync(join(realHome, ".ssh"), { recursive: true });
    writeFileSync(join(realHome, ".ssh", "config"), "Host x");
    const linkedHome = join(root, "linked-home");
    symlinkSync(realHome, linkedHome);
    symlinkSync(join(realHome, ".ssh", "config"), join(work, "notes.txt"));
    const r = confine(join(work, "notes.txt"), { home: linkedHome, dataDir: data });
    expect(r).toEqual({ ok: false, reason: "denied" });
    // negative control: the deny roots as given don't hold the link's real path; only resolving them catches it
    const real = realpathSync(join(work, "notes.txt"));
    expect(denyRoots(linkedHome, data).some(d => real === d || real.startsWith(d + sep))).toBe(false);
  });
  it("with roots, only files under them; a link out of a root is refused", () => {
    const allowed = join(root, "allowed");
    mkdirSync(allowed);
    writeFileSync(join(allowed, "a.txt"), "a");
    writeFileSync(join(work, "b.txt"), "b");
    symlinkSync(join(work, "b.txt"), join(allowed, "escape.txt"));
    expect(confine(join(allowed, "a.txt"), { ...rules(), roots: [allowed] })).toMatchObject({ ok: true });
    expect(confine(join(work, "b.txt"), { ...rules(), roots: [allowed] })).toEqual({ ok: false, reason: "denied" });
    expect(confine(join(allowed, "escape.txt"), { ...rules(), roots: [allowed] })).toEqual({ ok: false, reason: "denied" });
    expect(confine(join(work, "b.txt"), rules())).toMatchObject({ ok: true });       // negative control: no roots, no limit
  });
  it("refuses the control plane's and every node's own state, and each account's credentials, links into them included", () => {
    const at = (rel: string, content = "x") => { const p = join(home, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); return p; };
    const state = [".local/share/morndo/morndo.db", ".local/share/morndo-fleet/fleet.db", ".local/state/morndo-fleet/fleet.sock.lock",
      ".local/state/morndo-node/agent.db", ".config/morndo-node/config.json", ".config/morndo-node/policy.json", ".config/morndo-fleet/config.json",
      ".local/share/kira/state.json", ".config/kira/config.json"].map(rel => at(rel));
    const credentials = [at(".claude/.credentials.json"), at(".claude-accounts/acct2/.credentials.json")];
    symlinkSync(state[0] ?? "", join(work, "notes.txt"));
    const reason = (p: string) => { const r = confine(p, rules()); return r.ok ? "ok" : r.reason; };
    for (const p of state) expect(reason(p), p).toBe("denied");
    for (const p of credentials) expect(reason(p), p).toBe("secret");
    expect(reason(join(work, "notes.txt"))).toBe("denied");                   // a link into the hub's database
    expect(reason(at(".local/share/other/x.txt"))).toBe("ok");                // negative control: a neighbour of theirs passes
    expect(reason(at(".config/morn/x.txt"))).toBe("ok");
  });
});

describe("common credential files (final review M2)", () => {
  it("refuses ~/.git-credentials, credentials.toml, .pgpass and ~/.claude.json, in any case and through a link", () => {
    const at = (rel: string) => { const p = join(home, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, "x"); return p; };
    const reason = (p: string) => { const r = confine(p, rules()); return r.ok ? "ok" : r.reason; };
    const secrets = [at(".git-credentials"), at(".cargo/credentials.toml"), at(".pgpass"), at(".claude.json"), at(".claude.json.backup"),
      at(".claude-accounts/acct2/.claude.json"), join(work, ".pgpass")];
    writeFileSync(join(work, ".pgpass"), "host:5432:db:me:pw");
    for (const p of secrets) expect(reason(p), p).toBe("secret");
    // Another case: a secret by name whatever the case (on darwin the volume folds case, so these are the same files).
    for (const rel of [".GIT-CREDENTIALS", ".Cargo/Credentials.TOML", ".PGPASS", ".Claude.json"]) expect(reason(join(home, rel)), rel).toBe("secret");
    symlinkSync(join(home, ".git-credentials"), join(work, "notes.txt"));
    expect(reason(join(work, "notes.txt"))).toBe("secret");                   // a link: its target's name counts
    expect(denyRoots(home, data)).toEqual(expect.arrayContaining([join(home, ".git-credentials"), join(home, ".claude.json")]));
    // negative control: neighbours of those names pass
    for (const rel of ["credentials.txt", ".claude.jsonl", "my.pgpass", ".git-credentials-helper.md"]) expect(reason(at(`work2/${rel}`)), rel).toBe("ok");
  });
});

describe("confine on a case-insensitive volume", () => {
  it("a deny root asked for in another case is still refused (denied where the volume folds case, missing where it does not)", () => {
    const at = (rel: string) => { const p = join(home, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, "x"); return p; };
    at(".ssh/config"); at(".config/morndo-node/x"); at(".claude/.credentials.json");
    const folds = process.platform === "darwin" || process.platform === "win32";
    const reason = (p: string) => { const r = confine(p, rules()); return r.ok ? "ok" : r.reason; };
    for (const rel of [".SSH/config", ".Ssh/CONFIG", ".CONFIG/MORNDO-NODE/x", ".SSH/absent", ".Local/Share/Morndo-Fleet/absent", ".Claude/.credentials.json"]) {
      expect(reason(join(home, rel)), rel).toBe(rel.endsWith("credentials.json") ? "secret" : folds ? "denied" : "missing");   // a secret by name, whatever the case
    }
    expect(reason(join(home, ".ssh", "config"))).toBe("denied");               // negative control: the exact spelling
  });
});

describe("deniedBy", () => {
  it("a root is itself and what lies under it; a root ending in * is a prefix", () => {
    const roots = ["/h/.ssh", "/h/.config/morndo*"];
    for (const p of ["/h/.ssh", "/h/.ssh/id", "/h/.config/morndo", "/h/.config/morndo-node/key", "/h/.config/morndo-fleet"]) expect(deniedBy(p, roots), p).toBe(true);
    for (const p of ["/h/.sshx", "/h/.config/morn", "/h/.config/other/morndo", "/h/x/.ssh"]) expect(deniedBy(p, roots), p).toBe(false);
  });
});

describe("API-key files and their directories (ADR-0018 PR 0)", () => {
  it("refuses the resolved engines, claude and store directories, and a legacy path only when configured", () => {
    const at = (rel: string) => { const p = join(home, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, "x"); return p; };
    const credits = at(".config/claude-credits/notes.json");
    const engines = at(".config/engines/settings.json");
    symlinkSync(credits, join(work, "via-credits.txt"));
    symlinkSync(engines, join(work, "via-engines.txt"));
    const reason = (p: string, deny?: DenyConfig) => {
      const r = confine(p, deny ? { ...rules(), deny } : rules());
      return r.ok ? "ok" : r.reason;
    };
    expect(reason(engines)).toBe("denied");
    expect(reason(join(work, "via-engines.txt"))).toBe("denied");
    expect(denyRoots(home, data)).toEqual(expect.arrayContaining([join(home, ".config/engines"), join(home, ".config/morndo-connections"), join(home, ".config/claude-credits")]));
    expect(reason(credits)).toBe("denied");
    expect(reason(join(work, "via-credits.txt"))).toBe("denied");
    const extra = join(work, "legacy-extra");
    mkdirSync(extra);
    writeFileSync(join(extra, "notes.json"), "x");
    expect(reason(join(extra, "notes.json"), { legacy: [extra] })).toBe("denied");
    expect(reason(credits, { legacy: [extra] })).toBe("denied");
    const srv = join(work, "srv-engines");
    mkdirSync(srv);
    const settings = join(srv, "engines.json");
    writeFileSync(settings, "x");
    writeFileSync(join(srv, "notes.json"), "x");
    expect(reason(join(srv, "notes.json"), { enginesConfig: settings })).toBe("denied");
    const claude = join(work, "claude-cfg");
    mkdirSync(claude);
    writeFileSync(join(claude, "sessions.json"), "x");
    expect(reason(join(claude, "sessions.json"), { claudeConfigDir: claude })).toBe("denied");
    const xdg = join(work, "xdg");
    for (const rel of ["engines/settings.json", "morndo-connections/vendors.json"]) {
      const p = join(xdg, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, "x");
      expect(reason(p, { xdgConfigHome: xdg }), rel).toBe("denied");
    }
    // negative control: neighbours of those directories pass
    expect(reason(at(".config/claude/notes.json"))).toBe("ok");
    expect(reason(at(".config/engines-other/notes.json"))).toBe("ok");
    const homeFile = join(home, "engines.json");
    writeFileSync(homeFile, "x");
    writeFileSync(join(home, "other.txt"), "x");
    expect(reason(homeFile, { enginesConfig: homeFile })).toBe("denied");
    expect(reason(join(home, "other.txt"), { enginesConfig: homeFile })).toBe("ok");
    expect(denyRoots(home, data, { enginesConfig: homeFile })).not.toContain(home);
    const lines: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      expect(denyRoots(home, data, { enginesConfig: process.cwd() })).not.toContain(process.cwd());
      expect(deniedBy(join(process.cwd(), "engines.json"), denyRoots(home, data, { enginesConfig: join(process.cwd(), "engines.json") }))).toBe(true);
      expect(deniedBy(join(process.cwd(), "readme.md"), denyRoots(home, data, { enginesConfig: join(process.cwd(), "engines.json") }))).toBe(false);
      expect(reason(join(work, "plain.txt"), { enginesConfig: "engines.json" })).toBe("missing");
      writeFileSync(join(work, "plain.txt"), "x");
      expect(reason(join(work, "plain.txt"), { enginesConfig: "engines.json" })).toBe("ok");
      expect(lines.join("")).toContain("ENGINES_CONFIG ignored: not an absolute path (engines.json)");
      expect(denyRoots(home, data, { enginesConfig: "engines.json" })).not.toContain(process.cwd());
    } finally { process.stderr.write = write; }
    const cfg1 = join(home, ".config/claude-credits/cfg-1");
    const homeClaude = join(home, ".claude");
    mkdirSync(cfg1, { recursive: true });
    mkdirSync(homeClaude, { recursive: true });
    writeFileSync(join(cfg1, "notes.json"), "x");
    writeFileSync(join(homeClaude, "sessions.json"), "x");
    const both = denyConfigWithClaudeDir({ claudeConfigDir: cfg1 }, homeClaude);
    expect(reason(join(cfg1, "notes.json"), both)).toBe("denied");
    expect(reason(join(homeClaude, "sessions.json"), both)).toBe("denied");
  });
  it("refuses *-api-key and key-<digits> by name, in any case and through a symlink", () => {
    const at = (rel: string) => { const p = join(home, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, "x"); return p; };
    const reason = (p: string) => { const r = confine(p, rules()); return r.ok ? "ok" : r.reason; };
    const secrets = [
      at("work3/anthropic-api-key"), at("work3/openai-api-key"), at("work3/api-key"), at("work3/api_key"), at("work3/apikey"),
      at("work3/openai_api_key"), at("work3/anthropic-api-key.txt"), at("work3/foo-api-key.bak"),
      at("work3/api-key.old"), at("work3/openai_api_key~"), at("work3/key-1.bak"),
      join(work, "key-1"), join(work, "key-12"),
    ];
    writeFileSync(join(work, "key-1"), "x");
    writeFileSync(join(work, "key-12"), "x");
    for (const p of secrets) expect(reason(p), p).toBe("secret");
    for (const rel of ["Anthropic-API-KEY", "KEY-7"]) expect(reason(at(`work3/${rel}`)), rel).toBe("secret");
    symlinkSync(join(work, "key-1"), join(work, "innocent.txt"));
    symlinkSync(at("work3/anthropic-api-key"), join(work, "notes.txt"));
    expect(reason(join(work, "innocent.txt"))).toBe("secret");
    expect(reason(join(work, "notes.txt"))).toBe("secret");
    // negative control: neighbours of those names pass
    for (const rel of ["key-", "key-a", "keys-1", "notes-api-keys", "api-key.ts", "apiKey.md", "openai_api_key.py"]) expect(reason(at(`work3/${rel}`)), rel).toBe("ok");
  });
});

describe("openConfined", () => {
  it("opens what confine allows, and refuses what it refuses", async () => {
    writeFileSync(join(work, "shot.png"), "png-bytes");
    const r = await openConfined(join(work, "shot.png"), rules());
    expect(r).toMatchObject({ ok: true, real: realpathSync(join(work, "shot.png")), size: 9 });
    if (r.ok) { expect((await r.fh.readFile()).toString()).toBe("png-bytes"); await r.fh.close(); }
    writeFileSync(join(home, ".ssh", "id_ed25519"), "key");
    expect(await openConfined(join(home, ".ssh", "id_ed25519"), rules())).toEqual({ ok: false, reason: "secret" });
    expect(await openConfined(join(work, "missing.png"), rules())).toEqual({ ok: false, reason: "missing" });
    const claude = join(work, "claude-cfg");
    mkdirSync(claude);
    writeFileSync(join(claude, "sessions.json"), "x");
    const allowed = await openConfined(join(claude, "sessions.json"), rules());
    expect(allowed.ok).toBe(true);
    if (allowed.ok) await allowed.fh.close();
    expect(await openConfined(join(claude, "sessions.json"), { ...rules(), deny: { claudeConfigDir: claude } })).toEqual({ ok: false, reason: "denied" });
  });
  it("never follows a link in the last place (one swapped in after confine looked); a file opens (negative control)", async () => {
    writeFileSync(join(home, ".ssh", "config"), "Host x");
    symlinkSync(join(home, ".ssh", "config"), join(work, "swapped.txt"));
    await expect(openNoFollow(join(work, "swapped.txt"))).rejects.toMatchObject({ code: "ELOOP" });
    writeFileSync(join(work, "plain.txt"), "plain");
    const fh = await openNoFollow(join(work, "plain.txt"));
    expect((await fh.readFile()).toString()).toBe("plain");
    await fh.close();
  });
});
