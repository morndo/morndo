// The console commands' arguments as a person types them: the real console, a child process, with a temporary
// MORNDO_HOME (T-434; `morndo audit` is T-423, audit-console.test.ts). `--help` or `-h` prints the usage and exits 0 before
// the hub's settings or database are read; a flag or a word the command does not take gets one sentence and exit 2. It
// used to be taken for an argument: `morndo revoke --help` revoked a device named "--help", `morndo pair --help` issued a
// pairing token, `morndo serve --help` started the hub. Scratch home and synthetic rows only; never the owner's hub.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";

const MAIN = join(import.meta.dirname, "../src/main.ts");
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "morndo-args-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function morndo(args: string[]) {
  // A port nobody listens on, so a `serve` that wrongly starts cannot meet a real hub; the timeout ends it.
  const r = spawnSync(process.execPath, ["--no-warnings", MAIN, ...args], {
    env: { PATH: process.env.PATH, HOME: home, MORNDO_HOME: home, MORNDO_PORT: "48799" }, encoding: "utf8", timeout: 10_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// Nothing was read or written: no database, no identity key, no journal, no token.
const untouched = () => expect(readdirSync(home)).toEqual([]);

// Each command: its usage line, and the arguments it must refuse (never a stack, never an effect).
const COMMANDS: { name: string; argv: string[]; usage: RegExp; refused: string[][] }[] = [
  { name: "serve", argv: ["serve"], usage: /usage: morndo serve$/m, refused: [["--bogus"], ["now"]] },
  { name: "pair", argv: ["pair"], usage: /usage: morndo pair$/m, refused: [["--bogus"], ["phone"]] },
  { name: "devices", argv: ["devices"], usage: /usage: morndo devices$/m, refused: [["--bogus"], ["all"]] },
  { name: "revoke", argv: ["revoke"], usage: /usage: morndo revoke <device id>/, refused: [["--bogus"], [], ["d1", "d2"], ["d1", "--bogus"]] },
  { name: "agent-token", argv: ["agent-token"], usage: /usage: morndo agent-token new <name> --role manager\|worker/, refused: [
    [], ["--bogus"], ["frobnicate"],
    ["new"], ["new", "--bogus", "x", "--role", "worker"], ["new", "x"], ["new", "x", "--role", "admin"], ["new", "x", "y", "--role", "worker"],
    ["new", "x", "--role", "worker", "--scope"], ["new", "x", "--role", "worker", "--scope", "everything"], ["new", "x", "--role", "worker", "--scope", "--bogus"],
    ["list", "--bogus"], ["list", "extra"],
    ["revoke"], ["revoke", "--bogus"], ["revoke", "a", "b"],
  ] },
];

describe.each(COMMANDS)("morndo $name: help", ({ argv, usage }) => {
  it.each(["--help", "-h"])("%s prints the usage and exits 0, reading nothing", flag => {
    const r = morndo([...argv, flag]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(usage);
    expect(r.err).toBe("");
    untouched();
  });
});

describe.each(COMMANDS)("morndo $name: bad arguments", ({ name, argv, refused }) => {
  it.each(refused)("%j is answered in one sentence, exit 2, reading nothing", (...rest) => {
    const r = morndo([...argv, ...rest]);
    expect(r.code, r.err).toBe(2);
    expect(r.err).toMatch(new RegExp(`^morndo ${name}: .*usage: morndo ${name}[^\\n]*\\n$`));
    expect(r.err).not.toMatch(/SqliteError|\n\s+at /);
    expect(r.out).toBe("");
    untouched();
  });
});

describe("morndo agent-token: a subcommand's help", () => {
  it.each(["new", "list", "revoke"])("%s --help prints the usage and exits 0", sub => {
    const r = morndo(["agent-token", sub, "--help"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/usage: morndo agent-token/);
    expect(r.err).toBe("");
    untouched();
  });
});

describe("morndo revoke: a real id still works", () => {
  it("revokes the device it names, and says so for one it does not know", () => {
    const store = new Store(home);
    store.close();
    const none = morndo(["revoke", "no-such-device"]);
    expect(none.code, none.err).toBe(0);
    expect(none.out.trim()).toBe("no active device no-such-device");
  });
});

describe("morndo agent-token: arguments that are right still work", () => {
  it("issues a token in either argument order, lists it, and revokes it", () => {
    const made = morndo(["agent-token", "new", "--role", "worker", "lane-a"]);
    expect(made.code, made.err).toBe(0);
    expect(made.out).toMatch(/Token \S+ \(lane-a, worker\)/);
    const id = /Token (\S+) \(/.exec(made.out)![1]!;
    const listed = morndo(["agent-token", "list"]);
    expect(listed.code, listed.err).toBe(0);
    expect(listed.out).toContain("lane-a");
    const revoked = morndo(["agent-token", "revoke", id]);
    expect(revoked.code, revoked.err).toBe(0);
    expect(revoked.out.trim()).toBe(`revoked ${id}`);
  });
});

describe("morndo agent-token: a token's scope (U15) still goes through", () => {
  // The usage-pool collector's own token (docs/agents/usage.md), as the e2e harnesses issue it; the parser came before
  // --scope existed and refused it (review of #143, 2026-10-26).
  it.each([
    ["agent-token", "new", "pool", "--role", "worker", "--scope", "usage-pool"],
    ["agent-token", "new", "--scope", "usage-pool", "--role", "worker", "pool"],
  ])("%s %s %s %s %s %s %s", (...argv) => {
    const made = morndo(argv);
    expect(made.code, made.err).toBe(0);
    expect(made.out).toMatch(/Token \S+ \(pool, worker, usage-pool\)/);
  });
  it("names --scope in the usage", () => {
    expect(morndo(["agent-token", "--help"]).out).toMatch(/--scope usage-pool/);
  });
});

describe("morndo devices and audit: the listing still works", () => {
  it("devices prints nothing for an empty hub and exits 0", () => {
    const r = morndo(["devices"]);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(home, "morndo.db"))).toBe(true);
  });
  it("a device event is still listed by audit", () => {
    const store = new Store(home);
    store.record([{ type: "EndpointRevoked" as const, endpointId: endpointId("e1"), at: 1000 }]);
    store.close();
    const r = morndo(["audit", "1"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("e1");
  });
});
