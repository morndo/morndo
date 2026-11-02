import { SIGNIN_ACCOUNT, type SignInRuntime } from "@morndo/domain";
import type { AccountRow } from "@morndo/protocol";

const RUNTIME_WORD: Record<SignInRuntime, string> = { claude: "Claude", cursor: "Cursor" };

export function sheetTitle(node: string, runtime: SignInRuntime, account: string, create: boolean): string {
  const word = RUNTIME_WORD[runtime];
  if (create) return `Sign in: add ${word} ${account} on ${node}`;
  if (runtime === "cursor") return `Sign in: ${word} on ${node}`;
  return account === "main" ? `Sign in: ${word} (main) on ${node}` : `Sign in: ${word} ${account} on ${node}`;
}

export function accountStateWords(row: AccountRow): string {
  if (row.retired) return "Retired";
  if (row.signedIn === "ok") return "Signed in";
  if (row.signedIn === "missing") return "Signed out";
  return "Unknown";
}

export function problemWords(problem: string | null, phase: string): string {
  if (phase === "expired") return "This sign-in timed out.";
  if (problem === "already_signed_in") {
    return "Cursor is already signed in on this node. Signing in again would sign it out if it isn't finished, so it isn't started.";
  }
  if (problem === "node_lost") return "The node lost this sign-in (it restarted). Try again.";
  if (problem === "node_offline") return "The node can't be reached right now.";
  if (problem === "code_refused") return "The sign-in page's code was not accepted.";
  if (problem === "credentials_mode") return "The login file's permissions are wrong on the node.";
  return "The sign-in did not finish.";
}

export function badAccountName(name: string): string | null {
  if (SIGNIN_ACCOUNT.test(name)) return null;
  return "Use lowercase letters, digits, dashes and underscores; 1–31 characters, not main.";
}
