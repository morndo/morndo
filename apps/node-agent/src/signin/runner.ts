import { execFile } from "node:child_process";
import { chmodSync, existsSync, lstatSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  SIGNIN_ACCOUNT, SIGNIN_TTL_MS, linkAllowed, type SignInIdentity, type SignInPhase, type SignInRuntime,
} from "@morndo/domain";
import { Decrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import type { OpArgs, OpResult } from "@morndo/protocol";
import { fail, ok, type Outcome } from "../ops/executor.ts";
import type { AccountHomes } from "./homes.ts";
import { RECIPES, sessionCommand } from "./recipes.ts";
import type { SignInTerminal } from "./terminal.ts";

const run = promisify(execFile);
const LINK_WAIT_MS = 30_000;
const POLL_MS = 150;
const MAX_LIVE = 4;
const ACCOUNT_CHECK_MS = 20_000;
const POOL_LIST_MS = 20_000;
const STATUS_RETRIES = 3;
const STATUS_RETRY_MS = 300;
const PATH_ENV = { PATH: process.env.PATH ?? "" };

type AgeIdentity = Awaited<ReturnType<typeof generateX25519Identity>>;

type Session = {
  id: string;
  runtime: SignInRuntime;
  account: string;
  create: boolean;
  createdHome: boolean;
  claudeConfigDir: string | null;
  credentialsPath: string;
  phase: SignInPhase;
  link: string;
  needsCode: boolean;
  recipient: string | null;
  expiresAt: number;
  identity: SignInIdentity | null;
  problem: string | null;
  ageIdentity: AgeIdentity | null;
  sentCode: boolean;
};

const targetSlotKey = (runtime: SignInRuntime, account: string): string => `${runtime}\0${account}`;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const execOut = (e: unknown): string => {
  const x = (typeof e === "object" && e !== null ? e : {}) as { stdout?: unknown };
  return typeof x.stdout === "string" ? x.stdout : "";
};

const codeOk = (text: string): boolean => {
  if (text.length === 0 || text.length > 512 || text.includes("\n")) return false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 32 || c === 127) return false;
  }
  return true;
};

// The email an account's own settings file last named (Claude Code's oauthAccount.emailAddress); no credential is read.
function lastEmail(settingsFile: string): string | null {
  try {
    const j = JSON.parse(readFileSync(settingsFile, "utf8")) as { oauthAccount?: { emailAddress?: unknown } };
    const e = j.oauthAccount?.emailAddress;
    return typeof e === "string" && e.length > 0 && e.length <= 320 ? e : null;
  } catch { return null; }
}

export class SignInRunner {
  readonly #terminal: SignInTerminal;
  readonly #homes: AccountHomes;
  readonly #bins: { claude: string; cursor: string };
  readonly #now: () => number;
  readonly #recordCreatedHome: ((row: { runtime: SignInRuntime; account: string }) => void) | null;
  readonly #sessions = new Map<string, Session>();
  readonly #pendingTargets = new Set<string>();

  constructor(o: {
    terminal: SignInTerminal;
    homes: AccountHomes;
    bins: { claude: string; cursor: string };
    now: () => number;
    recordCreatedHome?: (row: { runtime: SignInRuntime; account: string }) => void;
  }) {
    this.#terminal = o.terminal;
    this.#homes = o.homes;
    this.#bins = o.bins;
    this.#now = o.now;
    this.#recordCreatedHome = o.recordCreatedHome ?? null;
  }

  async reap(): Promise<void> {
    await this.#reapExpired();
    this.#reapExpiredHomes();
  }

  async accounts(a: OpArgs["signin.accounts"]): Promise<Outcome<"signin.accounts">> {
    await this.#reapExpired();
    return a.runtime === "claude" ? this.#claudeAccounts() : this.#cursorAccounts();
  }

  async start(a: OpArgs["signin.start"]): Promise<Outcome<"signin.start">> {
    await this.#reapExpired();
    if (!SIGNIN_ACCOUNT.test(a.account)) return fail("bad_args", "bad_account");
    if (a.create && a.account === "main") return fail("bad_args", "bad_account");
    if (a.runtime === "cursor" && a.account !== "main") return fail("not_allowed", "cursor_main_only");

    const existing = this.#sessions.get(a.id);
    if (existing && this.#isLive(existing)) return ok<"signin.start">(this.#startView(existing));

    if (this.#busyTarget(a.runtime, a.account)) return fail("busy", "a sign-in is already running for this account");
    if (this.#liveCount() >= MAX_LIVE) return fail("busy", "too many sign-ins at once");

    const slot = targetSlotKey(a.runtime, a.account);
    this.#pendingTargets.add(slot);
    try {
      if (a.runtime === "cursor") {
        const signedIn = await this.#cursorSignedIn();
        if (signedIn === "ok") return fail("not_allowed", "already_signed_in");
        if (signedIn !== "missing") return fail("not_allowed", "cursor_status_unknown");
      }

      const resolved = await this.#homes.ensure(a.runtime, a.account, a.create);
      if ("code" in resolved) return fail(resolved.code, resolved.message);

      if (a.runtime === "claude" && a.account !== "main" && resolved.claudeConfigDir) {
        try { statSync(resolved.claudeConfigDir); } catch { return fail("not_allowed", "no_account"); }
      }

      const recipe = RECIPES[a.runtime];
      const argv = recipe.argv(this.#bins);
      const cmd = sessionCommand(this.#homes.home, argv[0]!, argv.slice(1), recipe.extraEnv(this.#homes.home, resolved.claudeConfigDir));

      try { await this.#terminal.open(a.id, cmd); }
      catch {
        await this.#abortStart(a.id, a.runtime, a.account, resolved);
        return fail("internal", "could not start sign-in terminal");
      }

      let linkOut: { ok: true; link: string; screen: string } | { ok: false; code: "timeout" | "internal"; message: string };
      try { linkOut = await this.#waitForLink(a.id, a.runtime, recipe.link); }
      catch {
        await this.#abortStart(a.id, a.runtime, a.account, resolved);
        return fail("internal", "could not start sign-in terminal");
      }
      if (!linkOut.ok) {
        await this.#abortStart(a.id, a.runtime, a.account, resolved);
        return fail(linkOut.code, linkOut.message);
      }

      if (resolved.createdHome && this.#recordCreatedHome) this.#recordCreatedHome({ runtime: a.runtime, account: a.account });

      const needsCode = recipe.codePrompt !== null && recipe.codePrompt.test(linkOut.screen);
      let recipient: string | null = null;
      let ageIdentity: AgeIdentity | null = null;
      if (needsCode) {
        ageIdentity = await generateX25519Identity();
        recipient = await identityToRecipient(ageIdentity);
      }

      const credentialsPath = a.runtime === "claude"
        ? join(resolved.accountHome, ".credentials.json")
        : join(this.#homes.home, ".config", "cursor", "auth.json");

      const session: Session = {
        id: a.id,
        runtime: a.runtime,
        account: a.account,
        create: a.create,
        createdHome: resolved.createdHome,
        claudeConfigDir: resolved.claudeConfigDir,
        credentialsPath,
        phase: "waiting",
        link: linkOut.link,
        needsCode,
        recipient,
        expiresAt: this.#now() + SIGNIN_TTL_MS,
        identity: null,
        problem: null,
        ageIdentity,
        sentCode: false,
      };
      this.#sessions.set(a.id, session);
      return ok<"signin.start">(this.#startView(session));
    } finally {
      this.#pendingTargets.delete(slot);
    }
  }

  async code(a: OpArgs["signin.code"]): Promise<Outcome<"signin.code">> {
    await this.#reapExpired();
    const s = this.#sessions.get(a.id);
    if (!s) return fail("no_session", "no such sign-in");
    await this.#expireIfNeeded(s);
    if (!this.#acceptsCode(s)) return ok<"signin.code">({ accepted: false });

    let plain: string;
    try {
      if (!s.ageIdentity) return ok<"signin.code">({ accepted: false });
      const dec = new Decrypter();
      dec.addIdentity(s.ageIdentity);
      plain = await dec.decrypt(Uint8Array.from(Buffer.from(a.sealed, "base64")), "text");
    } catch {
      return ok<"signin.code">({ accepted: false });
    }
    if (!codeOk(plain)) return ok<"signin.code">({ accepted: false });

    try {
      await this.#terminal.type(a.id, plain);
      await this.#terminal.enter(a.id);
    } catch {
      await this.#failFromTerminal(s, "node_lost");
      return ok<"signin.code">({ accepted: false });
    }
    s.sentCode = true;
    s.phase = "checking";
    return ok<"signin.code">({ accepted: true });
  }

  async status(a: OpArgs["signin.status"]): Promise<Outcome<"signin.status">> {
    await this.#reapExpired();
    const s = this.#sessions.get(a.id);
    if (!s) return fail("no_session", "no such sign-in");
    await this.#expireIfNeeded(s);
    try {
      await this.#refresh(s);
    } catch {
      await this.#failFromTerminal(s, "node_lost");
    }
    return ok<"signin.status">(this.#statusView(s));
  }

  async cancel(a: OpArgs["signin.cancel"]): Promise<Outcome<"signin.cancel">> {
    await this.#reapExpired();
    const s = this.#sessions.get(a.id);
    if (!s) return fail("no_session", "no such sign-in");
    if (this.#isFinal(s.phase)) return ok<"signin.cancel">({ cancelled: false });
    try { await this.#terminal.close(a.id); } catch { /* session may be gone */ }
    s.ageIdentity = null;
    s.phase = "cancelled";
    this.#maybeRemoveCreatedHome(s.runtime, s.account, s.createdHome, "cancelled");
    return ok<"signin.cancel">({ cancelled: true });
  }

  async #refresh(s: Session): Promise<void> {
    await this.#expireIfNeeded(s);
    if (!this.#isLive(s)) return;
    let ex: { dead: boolean; status: number | null };
    try {
      ex = await this.#terminal.exit(s.id);
    } catch {
      return;   // a busy tmux said nothing about the sign-in: ask again on the next status (the deadline still ends it)
    }
    if (!ex.dead) return;
    await this.#finish(s, ex.status);
  }

  async #failFromTerminal(s: Session, problem: string): Promise<void> {
    if (this.#isFinal(s.phase)) return;
    s.phase = "failed";
    s.problem = problem;
    s.ageIdentity = null;
    try { await this.#terminal.close(s.id); } catch { /* already gone */ }
    this.#maybeRemoveCreatedHome(s.runtime, s.account, s.createdHome, "failed");
  }

  async #finish(s: Session, exitStatus: number | null): Promise<void> {
    // tmux can mark a pane dead before it has the exit status: an unknown status is no verdict, the CLI's own status is.
    const known = exitStatus !== null && Number.isFinite(exitStatus);
    if (known && exitStatus !== 0) {
      s.phase = "failed";
      s.problem = s.sentCode ? "code_refused" : "not_signed_in";
      try { await this.#terminal.close(s.id); } catch { /* session may be gone */ }
      s.ageIdentity = null;
      this.#maybeRemoveCreatedHome(s.runtime, s.account, s.createdHome, "failed");
      return;
    }
    const id = await this.#loginIdentity(s);
    if (!id) {
      s.phase = "failed";
      s.problem = s.sentCode ? "code_refused" : "not_signed_in";
      try { await this.#terminal.close(s.id); } catch { /* session may be gone */ }
      s.ageIdentity = null;
      this.#maybeRemoveCreatedHome(s.runtime, s.account, s.createdHome, "failed");
      return;
    }
    if (s.runtime === "claude") {
      try {
        let mode = statSync(s.credentialsPath).mode & 0o777;
        if (mode !== 0o600) {
          chmodSync(s.credentialsPath, 0o600);
          mode = statSync(s.credentialsPath).mode & 0o777;
        }
        if (mode !== 0o600) {
          s.phase = "failed";
          s.problem = "credentials_mode";
          s.identity = null;
          try { await this.#terminal.close(s.id); } catch { /* session may be gone */ }
          s.ageIdentity = null;
          this.#maybeRemoveCreatedHome(s.runtime, s.account, s.createdHome, "failed");
          return;
        }
      } catch {
        s.phase = "failed";
        s.problem = "not_signed_in";
        try { await this.#terminal.close(s.id); } catch { /* session may be gone */ }
        s.ageIdentity = null;
        this.#maybeRemoveCreatedHome(s.runtime, s.account, s.createdHome, "failed");
        return;
      }
    }
    s.phase = "done";
    s.identity = id;
    s.problem = null;
    try { await this.#terminal.close(s.id); } catch { /* session may be gone */ }
    s.ageIdentity = null;
  }

  async #reapExpired(): Promise<void> {
    for (const s of this.#sessions.values()) {
      if (this.#isFinal(s.phase)) continue;
      if (this.#now() >= s.expiresAt) await this.#expireIfNeeded(s);
    }
  }

  #reapExpiredHomes(): void {
    for (const s of this.#sessions.values()) {
      if (s.phase === "expired") this.#maybeRemoveCreatedHome(s.runtime, s.account, s.createdHome, "expired");
    }
  }

  #maybeRemoveCreatedHome(runtime: SignInRuntime, account: string, createdHome: boolean, phase: SignInPhase): void {
    if (!createdHome || runtime !== "claude" || account === "main") return;
    if (phase === "done") return;
    if (!SIGNIN_ACCOUNT.test(account)) return;
    const root = join(this.#homes.home, ".claude-accounts");
    const dir = join(root, account);
    try {
      const st = lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) return;
      if (existsSync(join(dir, ".credentials.json"))) return;
      rmSync(dir, { recursive: true, force: true });
    } catch { /* leave anything else alone */ }
  }

  async #expireIfNeeded(s: Session): Promise<void> {
    if (this.#isFinal(s.phase)) return;
    if (this.#now() >= s.expiresAt && (s.phase === "waiting" || s.phase === "checking")) {
      try { await this.#terminal.close(s.id); } catch { /* session may be gone */ }
      s.ageIdentity = null;
      s.phase = "expired";
    }
  }

  #isLive(s: Session): boolean {
    return (s.phase === "waiting" || s.phase === "checking") && this.#now() < s.expiresAt;
  }

  #isFinal(phase: SignInPhase): boolean {
    return phase === "done" || phase === "failed" || phase === "expired" || phase === "cancelled";
  }

  #acceptsCode(s: Session): boolean {
    return s.phase === "waiting" && s.needsCode && s.recipient !== null && this.#now() < s.expiresAt;
  }

  #liveCount(): number {
    let n = 0;
    for (const s of this.#sessions.values()) if (this.#isLive(s)) n++;
    return n;
  }

  #busyTarget(runtime: SignInRuntime, account: string): boolean {
    if (this.#pendingTargets.has(targetSlotKey(runtime, account))) return true;
    for (const s of this.#sessions.values()) {
      if (this.#isLive(s) && s.runtime === runtime && s.account === account) return true;
    }
    return false;
  }

  #startView(s: Session): OpResult["signin.start"] {
    return { link: s.link, userCode: null, needsCode: s.needsCode, recipient: s.recipient, expiresAt: s.expiresAt };
  }

  #statusView(s: Session): OpResult["signin.status"] {
    return { phase: s.phase, identity: s.identity, problem: s.problem };
  }

  async #abortStart(id: string, runtime: SignInRuntime, account: string, resolved: { createdHome: boolean }): Promise<void> {
    try { await this.#terminal.close(id); } catch { /* session may be gone */ }
    this.#maybeRemoveCreatedHome(runtime, account, resolved.createdHome, "failed");
  }

  async #waitForLink(id: string, runtime: SignInRuntime, pattern: RegExp):
    Promise<{ ok: true; link: string; screen: string } | { ok: false; code: "timeout" | "internal"; message: string }> {
    const end = this.#now() + LINK_WAIT_MS;
    while (this.#now() < end) {
      let ex: { dead: boolean; status: number | null };
      try { ex = await this.#terminal.exit(id); }
      catch { await sleep(POLL_MS); continue; }
      if (ex.dead) return { ok: false, code: "timeout", message: "no_link" };
      const screen = await this.#terminal.screen(id);
      const m = pattern.exec(screen);
      if (m) {
        const link = m[0]!;
        if (!linkAllowed(runtime, link)) return { ok: false, code: "internal", message: "no_link" };
        return { ok: true, link, screen };
      }
      await sleep(POLL_MS);
    }
    return { ok: false, code: "timeout", message: "no_link" };
  }

  async #loginIdentity(s: Session): Promise<SignInIdentity | null> {
    return s.runtime === "claude" ? this.#claudeIdentity(s.claudeConfigDir) : this.#cursorIdentity();
  }

  async #claudeIdentity(claudeConfigDir: string | null): Promise<SignInIdentity | null> {
    const recipe = RECIPES.claude;
    const argv = recipe.argv(this.#bins);
    const cmd = sessionCommand(this.#homes.home, argv[0]!, ["auth", "status", "--json"], recipe.extraEnv(this.#homes.home, claudeConfigDir));
    try {
      const { stdout } = await run(cmd[0]!, cmd.slice(1), { encoding: "utf8", timeout: ACCOUNT_CHECK_MS, env: PATH_ENV });
      const j = JSON.parse(stdout) as { loggedIn?: boolean; email?: string; subscriptionType?: string };
      if (j.loggedIn !== true || typeof j.email !== "string") return null;
      return { email: j.email, plan: j.subscriptionType ?? null };
    } catch { return null; }
  }

  async #cursorIdentity(): Promise<SignInIdentity | null> {
    const recipe = RECIPES.cursor;
    const argv = recipe.argv(this.#bins);
    const cmd = sessionCommand(this.#homes.home, argv[0]!, ["status"], recipe.extraEnv(this.#homes.home, null));
    try {
      const { stdout } = await run(cmd[0]!, cmd.slice(1), { encoding: "utf8", timeout: ACCOUNT_CHECK_MS, env: PATH_ENV });
      const m = /Logged in as\s+(\S+)/.exec(stdout);
      if (!m) return null;
      return { email: m[1]!, plan: null };
    } catch { return null; }
  }

  async #claudeAccounts(): Promise<Outcome<"signin.accounts">> {
    const retired = await this.#poolRetired();
    const names = ["main", ...this.#homes.listClaudeAccountNames()];
    const rows = await Promise.all(names.map(async name => {
      const dir = name === "main" ? null : join(this.#homes.home, ".claude-accounts", name);
      const signedIn = await this.#claudeSignedIn(dir);
      // Signed in: the CLI's own email and plan, in one status call. Otherwise the last email the account's own settings
      // file holds (its oauthAccount), so the principal knows which account a folder was.
      const id = signedIn === "ok" ? await this.#claudeIdentity(dir) : null;
      return {
        name,
        signedIn,
        retired: name === "main" ? false : (retired.get(name) ?? false),
        plan: id?.plan ?? null,
        email: id?.email ?? lastEmail(dir === null ? join(this.#homes.home, ".claude.json") : join(dir, ".claude.json")),
      };
    }));
    return ok<"signin.accounts">({ accounts: rows });
  }

  async #cursorAccounts(): Promise<Outcome<"signin.accounts">> {
    const signedIn = await this.#cursorSignedIn();
    const id = signedIn === "ok" ? await this.#cursorIdentity() : null;
    return ok<"signin.accounts">({ accounts: [{ name: "main", signedIn, retired: false, plan: null, email: id?.email ?? null }] });
  }

  async #claudeSignedIn(claudeConfigDir: string | null): Promise<"ok" | "missing" | "unknown"> {
    const recipe = RECIPES.claude;
    const argv = recipe.argv(this.#bins);
    const cmd = sessionCommand(this.#homes.home, argv[0]!, ["auth", "status", "--json"], recipe.extraEnv(this.#homes.home, claudeConfigDir));
    for (let i = 0; i < STATUS_RETRIES; i++) {
      try {
        const { stdout } = await run(cmd[0]!, cmd.slice(1), { encoding: "utf8", timeout: ACCOUNT_CHECK_MS, env: PATH_ENV });
        const j = JSON.parse(stdout) as { loggedIn?: boolean };
        return j.loggedIn === true ? "ok" : "missing";
      } catch (e) {
        const out = execOut(e);
        if (out) {
          try {
            const j = JSON.parse(out) as { loggedIn?: boolean };
            if (j.loggedIn === false) return "missing";
            if (j.loggedIn === true) return "ok";
          } catch { /* not json */ }
        }
        const msg = typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : "";
        if (/not logged in/i.test(out) || /not logged in/i.test(msg)) return "missing";
        if (i < STATUS_RETRIES - 1) await sleep(STATUS_RETRY_MS);
      }
    }
    return "unknown";
  }

  async #cursorSignedIn(): Promise<"ok" | "missing" | "unknown"> {
    const recipe = RECIPES.cursor;
    const argv = recipe.argv(this.#bins);
    const cmd = sessionCommand(this.#homes.home, argv[0]!, ["status"], recipe.extraEnv(this.#homes.home, null));
    for (let i = 0; i < STATUS_RETRIES; i++) {
      try {
        const { stdout } = await run(cmd[0]!, cmd.slice(1), { encoding: "utf8", timeout: ACCOUNT_CHECK_MS, env: PATH_ENV });
        if (/Logged in as/i.test(stdout)) return "ok";
        if (/Not logged in/i.test(stdout)) return "missing";
      } catch {
        if (i < STATUS_RETRIES - 1) await sleep(STATUS_RETRY_MS);
      }
    }
    return "unknown";
  }

  async #poolRetired(): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    if (!this.#homes.claudePool) return out;
    try {
      const { stdout } = await run(this.#homes.claudePool, ["list", "--json"], { encoding: "utf8", timeout: POOL_LIST_MS, env: { ...PATH_ENV, HOME: this.#homes.home } });
      const today = new Date(this.#now()).toISOString().slice(0, 10);
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as { name?: string; retired?: string; expires?: string | null };
        if (typeof row.name !== "string") continue;
        const retired = (typeof row.retired === "string" && row.retired.length > 0)
          || (typeof row.expires === "string" && row.expires < today);
        out.set(row.name, retired);
      }
    } catch { /* no pool */ }
    return out;
  }
}
