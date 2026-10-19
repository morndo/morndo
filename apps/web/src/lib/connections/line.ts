// The line the machine runs. The key is typed there, never on this page, so it is not a parameter.
import { CONNECTION_WORDS } from "@morndo/protocol";

export function keyAddLine(input: { name: string; vendor: string; runtime: string; budget: string; expires: string }): string {
  const budget = input.budget.trim();
  const amount = Number(budget);
  if (budget !== "unlimited" && (!Number.isFinite(amount) || amount <= 0)) return "";
  const parts = [CONNECTION_WORDS.addLine, input.name, "--vendor", input.vendor, "--runtime", input.runtime, "--billing", "metered", "--budget", budget];
  if (input.expires) parts.push("--expires", input.expires);
  return `${parts.join(" ")} < keyfile`;
}

export function subscriptionAddLine(input: { name: string; vendor: string; runtime: string }): string {
  return [CONNECTION_WORDS.addLine, input.name, "--vendor", input.vendor, "--runtime", input.runtime, "--subscription", "true"].join(" ");
}

export function isolationLine(name: string, isolation: string): string {
  const bin = CONNECTION_WORDS.addLine.replace(/ add$/, "");
  return `${bin} isolation ${name} ${isolation}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const EXPIRY_PLACEHOLDER = "10 Oct 2026";

export function expiryText(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function expiryMillis(text: string): string {
  const match = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/.exec(text.trim());
  if (!match) return "";
  const day = Number(match[1]);
  const month = MONTHS.findIndex(item => item.toLowerCase() === match[2]!.toLowerCase());
  const year = Number(match[3]);
  if (month < 0) return "";
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return "";
  return String(date.getTime());
}

export function signInLine(runtime: string): string | null {
  if (runtime === "claude" || runtime === "codex" || runtime === "cursor") return CONNECTION_WORDS.signIn[runtime];
  return null;
}

// What to do before the sign-in line, where a runtime needs it (ADR-0028 decision 2).
export function signInNote(runtime: string): string | null {
  return runtime === "codex" ? CONNECTION_WORDS.signInNotes.codex : null;
}
