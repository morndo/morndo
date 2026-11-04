// Sign-in from the app (ADR-0039; docs/domain.md "Sign-in"). The principal signs one account of an agent CLI in, or adds
// one, from the app: the node runs the CLI's own sign-in for that account in a hidden terminal, the app shows its link,
// and a one-time code goes back sealed to that sign-in's own key. Pure: no I/O, no vendor code.
//
// Terms
// - Target: one account of one runtime on one node.
// - Account: "main" is the CLI's default home; any other name is a home of its own (Claude: ~/.claude-accounts/<name>).
// - Sign-in: one attempt to sign a Target in. The node's runner owns its real state; the hub keeps a copy.
//
// Invariants
// - SI1 One live sign-in per Target (the hub hands a second start the live one).
// - SI2 A code is taken only while one is awaited (waiting, needsCode) and before the deadline: acceptsCode.
// - SI3 done, failed, expired and cancelled are final: settle never leaves them.
// - SI4 A live sign-in past its deadline is expired: settle.
// - SI5 A link is https on the runtime's own hosts only: linkAllowed.
// - SI6 No code, token or sealed value is part of a SignIn (no field for one).
// - SI7 Starting and sending a code need a passkey check from the last SIGNIN_FRESH_MS, whatever the step-up policy.
// - SI8 Agents may ask for a card; they never start a sign-in, read its link or send a code.

export type SignInRuntime = "claude" | "cursor";
export const SIGNIN_RUNTIMES: readonly SignInRuntime[] = ["claude", "cursor"];

// The pool's own rule for an account name (claude-pool add), plus "main" for the CLI's default home.
export const SIGNIN_ACCOUNT = /^(main|[a-z0-9][a-z0-9_-]{0,30})$/;
const NODE = /^[a-z0-9-]{1,32}$/;    // the fleet's node names (protocol NODE_NAME)

export type SignInTarget = { node: string; runtime: SignInRuntime; account: string };
export type SignInPhase = "waiting" | "checking" | "done" | "failed" | "expired" | "cancelled";
export const LIVE_PHASES: ReadonlySet<SignInPhase> = new Set<SignInPhase>(["waiting", "checking"]);
export type SignInIdentity = { email: string; plan: string | null };

export type SignIn = {
  id: string;
  target: SignInTarget;
  create: boolean;                     // adds the account's home first
  phase: SignInPhase;
  link: string;                        // the CLI's own sign-in page
  userCode: string | null;             // a device code to type on that page, when the CLI shows one
  needsCode: boolean;                  // the CLI waits for the code the page shows (Claude)
  recipient: string | null;            // this sign-in's own age X25519 recipient, when needsCode
  startedAt: number;
  expiresAt: number;
  identity: SignInIdentity | null;     // who it signed in as, once done
  problem: string | null;              // why it failed, in fixed words
};

export const SIGNIN_TTL_MS = 10 * 60_000;
export const SIGNIN_FRESH_MS = 5 * 60_000;

export type TargetProblem = "bad_node" | "bad_runtime" | "bad_account" | "cursor_main_only";

export function checkTarget(t: { node: unknown; runtime: unknown; account: unknown }):
  { ok: true; target: SignInTarget } | { ok: false; problem: TargetProblem } {
  if (typeof t.runtime !== "string" || !(SIGNIN_RUNTIMES as readonly string[]).includes(t.runtime)) return { ok: false, problem: "bad_runtime" };
  if (typeof t.node !== "string" || !NODE.test(t.node)) return { ok: false, problem: "bad_node" };
  if (typeof t.account !== "string" || !SIGNIN_ACCOUNT.test(t.account)) return { ok: false, problem: "bad_account" };
  // Cursor keeps its login in $XDG_CONFIG_HOME/cursor, and the engine layer runs only the default one.
  if (t.runtime === "cursor" && t.account !== "main") return { ok: false, problem: "cursor_main_only" };
  return { ok: true, target: { node: t.node, runtime: t.runtime as SignInRuntime, account: t.account } };
}

export const targetKey = (t: SignInTarget): string => `${t.node}/${t.runtime}/${t.account}`;

const HOSTS: Record<SignInRuntime, (host: string) => boolean> = {
  claude: h => h === "claude.com" || h === "claude.ai" || h.endsWith(".anthropic.com"),
  cursor: h => h === "cursor.com" || h === "www.cursor.com",
};

// https, a host of letters, digits, dots and dashes (so no user info, no other scheme), an optional port, then the path.
const HTTPS = /^https:\/\/([A-Za-z0-9.-]{1,253})(?::\d{1,5})?(?:[/?#]|$)/;
export function linkAllowed(runtime: SignInRuntime, link: string): boolean {
  const m = HTTPS.exec(link);
  return m !== null && !/\s/.test(link) && HOSTS[runtime](m[1]!.toLowerCase());
}

export const acceptsCode = (s: SignIn, now: number): boolean =>
  s.phase === "waiting" && s.needsCode && s.recipient !== null && now < s.expiresAt;

export const settle = (s: SignIn, now: number): SignIn =>
  LIVE_PHASES.has(s.phase) && now >= s.expiresAt ? { ...s, phase: "expired" } : s;

const RUNTIME_WORD: Record<SignInRuntime, string> = { claude: "Claude", cursor: "Cursor" };

export function cardTitle(t: SignInTarget, create: boolean): string {
  const word = RUNTIME_WORD[t.runtime];
  if (create) return `Add ${word} account ${t.account} on ${t.node}`;
  if (t.runtime === "cursor") return `${word} on ${t.node} is signed out`;
  return t.account === "main" ? `${word} (main login) on ${t.node} is signed out` : `${word} ${t.account} on ${t.node} is signed out`;
}
