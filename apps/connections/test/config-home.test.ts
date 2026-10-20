// The real bins on a home with no ~/.config (T-95). The vault lives in ~/.config/morndo-connections; a person's home
// need not have a ~/.config yet, so the first run creates it (0700, as the XDG base directory spec asks of a missing
// directory: "an attempt should be made to create it with permission 0700 ... If the destination directory exists
// already the permissions should not be changed", https://specifications.freedesktop.org/basedir/latest/, read
// 2026-10-20) and the private directory inside it. It is not chmod'd, so a stricter umask is kept and none is widened.
// A ~/.config that exists is never touched. Homes are scratch directories; the bins run as children of this process.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const BINS = { "morndo-keys": "../src/main.ts", "morndo-secrets": "../src/secrets-main.ts" } as const;
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "morndo-config-home-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

// `list` opens the store and writes nothing else.
function run(bin: keyof typeof BINS, umask: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.MORNDO_CONNECTIONS_HOME;
  return spawnSync("sh", ["-c", `umask ${umask} && exec "$0" --no-warnings "$@"`, process.execPath, join(import.meta.dirname, BINS[bin]), "list"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
}
const mode = (path: string) => statSync(path).mode & 0o777;

describe.each(Object.keys(BINS) as (keyof typeof BINS)[])("%s on a home without ~/.config", bin => {
  it.each(["022", "077"])("creates ~/.config at 0700 and the private directory inside it, under umask %s", umask => {
    const r = run(bin, umask);
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    expect(mode(join(home, ".config"))).toBe(0o700);
    expect(mode(join(home, ".config/morndo-connections"))).toBe(0o700);
  });
  it("leaves an existing ~/.config with the mode it has", () => {
    mkdirSync(join(home, ".config"));
    chmodSync(join(home, ".config"), 0o750);
    const r = run(bin, "022");
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    expect(mode(join(home, ".config"))).toBe(0o750);
    expect(existsSync(join(home, ".config/morndo-connections"))).toBe(true);
    expect(mode(join(home, ".config/morndo-connections"))).toBe(0o700);
  });
});
