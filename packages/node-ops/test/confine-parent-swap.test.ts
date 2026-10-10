// A parent directory swapped for a symbolic link into a deny root between confine() and open() must be refused
// (spec README §3.1 "a link swapped in between is refused"). Forced window: node:fs/promises' open is wrapped so a rename
// fires exactly while openConfined is between its confine() and its open — deterministic, no timing. (Nothing between
// the two calls a FileHandle method, so the window is the open call itself.)
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openConfined } from "../src/file-rules.ts";

// The swap runs once, at the first open made from inside openConfined (after its confine() has judged the path).
const hook = vi.hoisted(() => ({ beforeOpen: null as null | (() => void), beforeStat: null as null | (() => void), fired: false }));
vi.mock("node:fs/promises", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const open: typeof real.open = (...a) => {
    const swap = hook.beforeOpen;
    if (swap && (new Error().stack ?? "").includes("openConfined")) { hook.beforeOpen = null; hook.fired = true; swap(); }
    return real.open(...a);
  };
  return { ...real, open };
});
// The narrower window inside confine itself, between its realpath and its stat: wrapped the same way, once, at the first
// statSync made from inside openConfined.
vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  const statSync = ((...a: Parameters<typeof real.statSync>) => {
    const swap = hook.beforeStat;
    if (swap && (new Error().stack ?? "").includes("openConfined")) { hook.beforeStat = null; hook.fired = true; swap(); }
    return real.statSync(...a);
  }) as typeof real.statSync;
  return { ...real, statSync };
});

let base: string, home: string, data: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "confine-swap-")));
  home = join(base, "home"); data = join(base, "data");
  mkdirSync(join(home, ".config", "gh"), { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(home, ".config", "gh", "hosts.yml"), "oauth_token: SECRET-V29\n");
  mkdirSync(join(home, "proj", "a"), { recursive: true });
  writeFileSync(join(home, "proj", "a", "hosts.yml"), "decoy\n");
  symlinkSync(join(home, ".config", "gh"), join(home, "proj", "link"));
  hook.beforeOpen = null; hook.beforeStat = null; hook.fired = false;
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("openConfined under a parent-directory swap", () => {
  it("refuses the file when proj/a becomes a link to a deny root between the check and the open", async () => {
    const asked = join(home, "proj", "a", "hosts.yml");
    hook.beforeOpen = () => {
      renameSync(join(home, "proj", "a"), join(home, "proj", "stash"));   // a absent
      renameSync(join(home, "proj", "link"), join(home, "proj", "a"));    // a = link to ~/.config/gh
    };
    const r = await openConfined(asked, { home, dataDir: data });
    expect(hook.fired).toBe(true);                                         // the window was really hit
    if (r.ok) { const buf = await r.fh.readFile(); await r.fh.close(); expect(buf.toString()).not.toContain("SECRET-V29"); }
    expect(r.ok).toBe(false);
  });
  // No link anywhere: the deny root's own directory renamed into the checked place. The open path has no link to refuse
  // (O_NOFOLLOW_ANY on darwin opens it), so only the open file's identity (dev, ino) against the one judged catches it.
  it("refuses a different file put in the checked place between the check and the open, with no link in the path", async () => {
    const asked = join(home, "proj", "a", "hosts.yml");
    hook.beforeOpen = () => {
      renameSync(join(home, "proj", "a"), join(home, "proj", "stash"));            // a absent
      renameSync(join(home, ".config", "gh"), join(home, "proj", "a"));            // a = the deny root's directory itself
    };
    const r = await openConfined(asked, { home, dataDir: data });
    expect(hook.fired).toBe(true);
    if (r.ok) { const buf = await r.fh.readFile(); await r.fh.close(); expect(buf.toString()).not.toContain("SECRET-V29"); }
    expect(r.ok).toBe(false);
  });
  // The link swapped in after confine's realpath but before its stat: the stat follows it, so the identity judged is the
  // deny root's file and the dev/ino check agrees with the open. Only an open that refuses a link in ANY component catches
  // it: darwin's O_NOFOLLOW_ANY. Linux has no such open flag reachable from Node (openat2's RESOLVE_NO_SYMLINKS needs a
  // raw syscall), so this narrower window is darwin's case only.
  it.runIf(process.platform === "darwin")("refuses the file when proj/a becomes a link between confine's realpath and its stat", async () => {
    const asked = join(home, "proj", "a", "hosts.yml");
    hook.beforeStat = () => {
      renameSync(join(home, "proj", "a"), join(home, "proj", "stash"));   // a absent
      renameSync(join(home, "proj", "link"), join(home, "proj", "a"));    // a = link to ~/.config/gh
    };
    const r = await openConfined(asked, { home, dataDir: data });
    expect(hook.fired).toBe(true);
    if (r.ok) { const buf = await r.fh.readFile(); await r.fh.close(); expect(buf.toString()).not.toContain("SECRET-V29"); }
    expect(r.ok).toBe(false);
  });
  // The same window on Linux, where no open flag refuses a parent link: only the kernel's own path of the open file
  // (/proc/self/fd/<fd>) shows that the open went through the link. Linux only (skipped elsewhere): darwin's open refuses
  // the link itself (the test above), and other systems have neither.
  it.runIf(process.platform === "linux")("refuses the file on Linux when proj/a becomes a link between confine's realpath and its stat", async () => {
    const asked = join(home, "proj", "a", "hosts.yml");
    hook.beforeStat = () => {
      renameSync(join(home, "proj", "a"), join(home, "proj", "stash"));   // a absent
      renameSync(join(home, "proj", "link"), join(home, "proj", "a"));    // a = link to ~/.config/gh
    };
    const r = await openConfined(asked, { home, dataDir: data });
    expect(hook.fired).toBe(true);
    if (r.ok) { const buf = await r.fh.readFile(); await r.fh.close(); expect(buf.toString()).not.toContain("SECRET-V29"); }
    expect(r.ok).toBe(false);
  });
  it("opens the checked file when nothing is swapped (negative control)", async () => {
    const r = await openConfined(join(home, "proj", "a", "hosts.yml"), { home, dataDir: data });
    expect(r.ok).toBe(true);
    if (r.ok) { expect((await r.fh.readFile()).toString()).toBe("decoy\n"); await r.fh.close(); }
  });
});
