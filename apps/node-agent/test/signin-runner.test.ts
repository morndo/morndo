// Sign-in from the app (ADR-0039): the node's runner drives each CLI's own sign-in in a hidden tmux, one account at a
// time per account, and opens a code only with that sign-in's own key. Real tmux; the CLIs are
// test/fixtures/fake-signin-cli.mjs. Locked by the keryx run app-sign-in.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Encrypter } from "age-encryption";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AccountHomes } from "../src/signin/homes.ts";
import { SignInRunner } from "../src/signin/runner.ts";
import { tmuxTerminal } from "../src/signin/terminal.ts";

const FAKE = join(import.meta.dirname, "../../../test/fixtures/fake-signin-cli.mjs");
const SOCKET = `signin-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const bins = { claude: FAKE, cursor: FAKE };
let home = "";
let clock = Date.now();
let runner: SignInRunner;

const mode = (p: string) => statSync(p).mode & 0o777;
const seal = async (recipient: string, code: string) => {
  const e = new Encrypter();
  e.addRecipient(recipient);
  return Buffer.from(await e.encrypt(code)).toString("base64");
};
const hasSession = (id: string) => {
  try { execFileSync("tmux", ["-L", SOCKET, "has-session", "-t", `=${id}`], { stdio: "ignore" }); return true; } catch { return false; }
};
async function until<T>(what: string, f: () => Promise<T | null>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 150));
  }
}
const phaseOf = async (id: string) => {
  const s = await runner.status({ id });
  if (!s.ok) throw new Error(`status ${id}: ${s.error.code} ${s.error.message}`);
  return s.result;
};
const finished = (id: string) => until(`${id} to finish`, async () => {
  const s = await phaseOf(id);
  return s.phase === "waiting" || s.phase === "checking" ? null : s;
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "signin-home-"));
  clock = Date.now();
  runner = new SignInRunner({ terminal: tmuxTerminal(SOCKET), homes: new AccountHomes({ home, bins, claudePool: null }), bins, now: () => clock });
});
afterAll(() => {
  try { execFileSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" }); } catch { /* none left */ }
});

describe("the node's sign-in runner (ADR-0039)", () => {
  it("adds a Claude account and signs it in with a sealed code, in that account's own locked-down home only", async () => {
    const started = await runner.start({ id: "si-add1", runtime: "claude", account: "a1", create: true });
    if (!started.ok) throw new Error(started.error.message);
    expect(started.result.link).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
    expect(started.result.needsCode).toBe(true);
    expect(started.result.recipient).toMatch(/^age1/);
    const dir = join(home, ".claude-accounts", "a1");
    expect(mode(dir)).toBe(0o700);
    const sealed = await seal(started.result.recipient!, "good-code");
    const sent = await runner.code({ id: "si-add1", sealed });
    expect(sent).toEqual({ ok: true, result: { accepted: true } });
    const end = await finished("si-add1");
    expect(end).toEqual({ phase: "done", identity: { email: "person@example.com", plan: "max" }, problem: null });
    expect(mode(join(dir, ".credentials.json"))).toBe(0o600);
    expect(existsSync(join(home, ".claude", ".credentials.json"))).toBe(false);
    for (const r of [JSON.stringify(started), JSON.stringify(sent), JSON.stringify(end)]) {
      expect(r).not.toContain("good-code");
      expect(r).not.toContain(sealed);
    }
    expect(hasSession("si-add1")).toBe(false);
  });

  it("runs two accounts at once; each code reaches its own sign-in and its own home", async () => {
    const [s1, s2] = await Promise.all([
      runner.start({ id: "si-two1", runtime: "claude", account: "a1", create: true }),
      runner.start({ id: "si-two2", runtime: "claude", account: "a2", create: true }),
    ]);
    if (!s1.ok || !s2.ok) throw new Error("both should start");
    expect(s1.result.recipient).not.toBe(s2.result.recipient);
    expect((await runner.code({ id: "si-two2", sealed: await seal(s2.result.recipient!, "good-code") })).ok).toBe(true);
    expect((await runner.code({ id: "si-two1", sealed: await seal(s1.result.recipient!, "wrong-code") })).ok).toBe(true);
    expect((await finished("si-two2")).phase).toBe("done");
    const failed = await finished("si-two1");
    expect(failed.phase).toBe("failed");
    expect(failed.identity).toBe(null);
    expect(existsSync(join(home, ".claude-accounts", "a2", ".credentials.json"))).toBe(true);
    expect(existsSync(join(home, ".claude-accounts", "a1", ".credentials.json"))).toBe(false);
  });

  it("opens a code only with its own sign-in's key: one sealed for another sign-in is refused and nothing is typed", async () => {
    const a = await runner.start({ id: "si-keyA", runtime: "claude", account: "a1", create: true });
    const b = await runner.start({ id: "si-keyB", runtime: "claude", account: "a2", create: true });
    if (!a.ok || !b.ok) throw new Error("both should start");
    expect(await runner.code({ id: "si-keyB", sealed: await seal(a.result.recipient!, "good-code") })).toEqual({ ok: true, result: { accepted: false } });
    expect((await phaseOf("si-keyB")).phase).toBe("waiting");
    expect(existsSync(join(home, ".claude-accounts", "a2", ".credentials.json"))).toBe(false);
    expect((await runner.code({ id: "si-nope", sealed: "YWdl" })).ok).toBe(false);
  });

  it("refuses an unsafe name, a symlinked home, a missing account, a second live sign-in for one account", async () => {
    const bad = await runner.start({ id: "si-bad", runtime: "claude", account: "../x", create: true });
    expect(bad.ok ? null : bad.error.code).toBe("bad_args");
    mkdirSync(join(home, ".claude-accounts"), { recursive: true });
    const elsewhere = mkdtempSync(join(tmpdir(), "signin-elsewhere-"));
    symlinkSync(elsewhere, join(home, ".claude-accounts", "a3"));
    const link = await runner.start({ id: "si-link", runtime: "claude", account: "a3", create: false });
    expect(link.ok ? null : [link.error.code, link.error.message]).toEqual(["not_allowed", "bad_home"]);
    const missing = await runner.start({ id: "si-miss", runtime: "claude", account: "a5", create: false });
    expect(missing.ok ? null : [missing.error.code, missing.error.message]).toEqual(["not_allowed", "no_account"]);
    expect((await runner.start({ id: "si-one", runtime: "claude", account: "a4", create: true })).ok).toBe(true);
    const again = await runner.start({ id: "si-one-b", runtime: "claude", account: "a4", create: false });
    expect(again.ok ? null : again.error.code).toBe("busy");
    mkdirSync(join(home, ".claude-accounts", "a7"), { recursive: true });
    const exists = await runner.start({ id: "si-exists", runtime: "claude", account: "a7", create: true });
    expect(exists.ok ? null : [exists.error.code, exists.error.message]).toEqual(["not_allowed", "exists"]);
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it("tightens an existing account home to 0700 before it signs in", async () => {
    const dir = join(home, ".claude-accounts", "a6");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o775);
    expect((await runner.start({ id: "si-tight", runtime: "claude", account: "a6", create: false })).ok).toBe(true);
    expect(mode(dir)).toBe(0o700);
  });

  it("closes the hidden terminal on cancel and at the deadline", async () => {
    expect((await runner.start({ id: "si-cancel", runtime: "claude", account: "a1", create: true })).ok).toBe(true);
    expect(hasSession("si-cancel")).toBe(true);
    expect(await runner.cancel({ id: "si-cancel" })).toEqual({ ok: true, result: { cancelled: true } });
    expect((await phaseOf("si-cancel")).phase).toBe("cancelled");
    expect(hasSession("si-cancel")).toBe(false);
    expect((await runner.start({ id: "si-late", runtime: "claude", account: "a2", create: true })).ok).toBe(true);
    clock += 10 * 60_000;
    expect((await phaseOf("si-late")).phase).toBe("expired");
    expect(hasSession("si-late")).toBe(false);
    const late = await runner.start({ id: "si-late2", runtime: "claude", account: "a2", create: false });
    if (!late.ok) throw new Error(late.error.message);
    expect(await runner.code({ id: "si-late", sealed: await seal(late.result.recipient!, "good-code") })).toEqual({ ok: true, result: { accepted: false } });
  });

  it("signs the Claude main login in to ~/.claude, without CLAUDE_CONFIG_DIR", async () => {
    const s = await runner.start({ id: "si-main", runtime: "claude", account: "main", create: false });
    if (!s.ok) throw new Error(s.error.message);
    expect((await runner.code({ id: "si-main", sealed: await seal(s.result.recipient!, "good-code") })).ok).toBe(true);
    expect((await finished("si-main")).phase).toBe("done");
    expect(existsSync(join(home, ".claude", ".credentials.json"))).toBe(true);
  });

  it("signs Cursor's main login in; it finishes by itself after the browser approves, with no code and no key", async () => {
    const s = await runner.start({ id: "si-cur", runtime: "cursor", account: "main", create: false });
    if (!s.ok) throw new Error(s.error.message);
    expect(s.result.link).toMatch(/^https:\/\/cursor\.com\/loginDeepControl\?/);
    expect(s.result.needsCode).toBe(false);
    expect(s.result.recipient).toBe(null);
    writeFileSync(join(home, ".config", "cursor", "approve"), "");
    expect(await finished("si-cur")).toEqual({ phase: "done", identity: { email: "person@example.com", plan: null }, problem: null });
    const named = await runner.start({ id: "si-cur2", runtime: "cursor", account: "c2", create: true });
    expect(named.ok ? null : [named.error.code, named.error.message]).toEqual(["not_allowed", "cursor_main_only"]);
  });

  it("lists the accounts it can sign in, with their state, without reading any secret", async () => {
    const s = await runner.start({ id: "si-list", runtime: "claude", account: "a1", create: true });
    if (!s.ok) throw new Error(s.error.message);
    await runner.code({ id: "si-list", sealed: await seal(s.result.recipient!, "good-code") });
    await finished("si-list");
    mkdirSync(join(home, ".claude-accounts", "a2"), { recursive: true });
    mkdirSync(join(home, ".claude-accounts", "Not-An-Account"), { recursive: true });
    const listed = await runner.accounts({ runtime: "claude" });
    if (!listed.ok) throw new Error(listed.error.message);
    const rows = Object.fromEntries(listed.result.accounts.map(a => [a.name, a.signedIn]));
    expect(rows).toEqual({ main: "missing", a1: "ok", a2: "missing" });
    expect(JSON.stringify(listed)).not.toContain("fake-refresh");
    expect(readFileSync(join(home, ".claude-accounts", "a1", ".credentials.json"), "utf8")).toContain("fake-refresh");
  });
});
