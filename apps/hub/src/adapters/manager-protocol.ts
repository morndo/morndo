// Anti-corruption adapter for the manager's chat protocol (its instructions, as kira's MANAGER-UI.md states them):
// - an answer whose first line is "[quiet]" is a routine update;
// - an answer whose last non-empty line is "[buttons <id>] key=Label | key=Label" asks a decision, the recommended
//   option first; 1 to 6 options, keys of letters, digits, "-" and "_" (up to 16), labels up to 40 characters;
// - the principal's tap reaches the manager typed as "[tap <id>] <key> (<Label>)".
// The grammar is the same as the chat bot's parseAnswer, so a line that bot rejects is rejected here too
// and stays plain text. One departure, stricter than kira: a label with a control character (an escape sequence, say) is
// rejected, since its tap is typed back into the manager's pane.

export type ButtonOption = { key: string; label: string };
export type ManagerAnswer = { quiet: boolean; body: string; buttons?: { id: string; options: ButtonOption[] }; bad?: string };

const QUIET = /^\s*\[quiet\]\s*/i;
const BUTTONS = /^\[buttons\s+([A-Za-z0-9_-]{1,32})\]\s*(.*)$/i;
const OPT = /^([A-Za-z0-9_-]{1,16})\s*=\s*(.+)$/;
const TAP = /^\[tap\s+([A-Za-z0-9_-]{1,32})\]\s+([A-Za-z0-9_-]{1,16})(?:\s+\((.*)\))?\s*$/;
export const MAX_OPTIONS = 6;
export const MAX_LABEL = 40;

export function parseAnswer(raw: string): ManagerAnswer {
  let text = String(raw ?? "").trim();
  const quiet = QUIET.test(text);
  if (quiet) text = text.replace(QUIET, "");
  const lines = text.split("\n");
  let last = lines.length - 1;
  while (last >= 0 && !lines[last]?.trim()) last--;
  const m = last >= 0 ? BUTTONS.exec(lines[last]?.trim() ?? "") : null;
  if (!m) return { quiet, body: text };
  const parts = (m[2] ?? "").split("|").map(s => s.trim()).filter(Boolean);
  const options = parts.map(s => OPT.exec(s)).map(o => (o ? { key: o[1] ?? "", label: (o[2] ?? "").trim() } : null));
  const bad = optionsProblem(options);
  if (bad) return { quiet, body: text, bad };
  return { quiet, body: lines.slice(0, last).join("\n").trimEnd(), buttons: { id: m[1] ?? "", options: options as ButtonOption[] } };
}

// What is wrong with a set of options, or "" when nothing is: the grammar's rules wherever the options come from (a
// button line, or the needs-you list's own options), since each one's tap is typed back into the manager's pane.
export function optionsProblem(options: readonly ({ key: string; label: string } | null)[]): string {
  return !options.length ? "no options"
    : options.length > MAX_OPTIONS ? `more than ${MAX_OPTIONS} options`
    : options.some(o => !o) ? "an option isn't key=Label"
    : options.some(o => !/^[A-Za-z0-9_-]{1,16}$/.test(o?.key ?? "")) ? "a key isn't letters, digits, - or _ (up to 16)"
    : options.some(o => (o?.label.length ?? 0) > MAX_LABEL) ? `a label is longer than ${MAX_LABEL} characters`
    : options.some(o => /[\x00-\x1f\x7f]/.test(o?.label ?? "")) ? "a label has a control character"
    : new Set(options.map(o => o?.key)).size !== options.length ? "a key is used twice" : "";
}

export const tapLine = (id: string, o: ButtonOption) => `[tap ${id}] ${o.key} (${o.label})`;

// The principal's answer in words to a list item: the manager files items by id, so the id leads.
export const wordsLine = (id: string, text: string) => `About ${id}: ${text.trim()}`;

export function parseTap(text: string): { id: string; key: string; label: string } | null {
  const m = TAP.exec(text.trim());
  return m ? { id: m[1] ?? "", key: m[2] ?? "", label: (m[3] ?? m[2] ?? "").trim() } : null;
}

export const isLedgerId = (id: string) => /^ny-/.test(id);
