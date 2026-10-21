// The short-card template (ADR-0023's amendment, board T-307): Key: value lines and an Options: block of "- key:
// Label | kind". It reads only that card format, by hand. It is not a general markdown parser. A problem here is one
// the draft cannot say (a line that is no field of the card, a field twice); the domain lints the draft it returns.
// JSON callers skip this adapter. The blank itself is the guide's fence, byte for byte.
import { shown, type BriefProblem, type CardOption } from "@morndo/domain";

export const CARD_TEMPLATE: string = "Id: ny-80\nOutcome: <one plain line: what is asked or what happened, no ids>\nRecommend: <key of the recommended option>\nOptions:\n- <key>: <Label> | stop\n- <key>: <Label> | continue\nDefault: <key of the option that applies if he does not answer>\nRisk: <optional: the live risk this touches, if there is one>\n";

const FIELD = /^(Id|Outcome|Recommend|Default|Risk|Options):\s*(.*)$/;
const OPTION = /^-\s+([^:\s]+):\s*(.+)$/;

const problem = (code: string, where: string, text: string): BriefProblem => ({ level: "error", code, where, text });

// The card file → the draft lintCard checks. Blank lines are ignored, a \r\n is read as \n, and the draft always has
// `options` (possibly empty): the lint names what is missing from there.
export function parseCardMarkdown(raw: string): { draft: Record<string, unknown>; problems: BriefProblem[] } {
  const draft: Record<string, unknown> = {};
  const options: CardOption[] = [];
  draft.options = options;
  const problems: BriefProblem[] = [];
  const seen = new Set<string>();
  let inOptions = false;
  for (const [i, line] of raw.replace(/\r\n/g, "\n").split("\n").entries()) {
    const n = i + 1;
    if (line.trim() === "") continue;
    const field = FIELD.exec(line);
    if (field !== null) {
      const key = field[1] ?? "";
      if (seen.has(key)) {
        problems.push(problem("duplicate_line", `line ${n}`, `"${key}:" appears twice; a field is one line`));
        continue;
      }
      seen.add(key);
      inOptions = key === "Options";
      // An empty value leaves the field out, so the lint names it missing rather than the parser guessing.
      const value = (field[2] ?? "").trim();
      if (!inOptions && value !== "") draft[key.toLowerCase()] = value;
      continue;
    }
    if (inOptions && line.startsWith("-")) {
      const option = OPTION.exec(line);
      if (option === null) {
        problems.push(problem("bad_option_line", `line ${n}`, `an option line is "- key: Label", not ${shown(line)}`));
        continue;
      }
      // The kind, when the asker marks it (T-307): everything after the first "|" — a label holds no "|" of its own,
      // so the bar is the kind's. The kind is optional in the format; under a live Risk the lint asks for it.
      const rest = option[2] ?? "";
      const bar = rest.indexOf("|");
      const label = (bar < 0 ? rest : rest.slice(0, bar)).trim();
      if (bar < 0) {
        options.push({ key: option[1] ?? "", label });
        continue;
      }
      const kind = rest.slice(bar + 1).trim();
      if (kind !== "stop" && kind !== "continue") {
        problems.push(problem("bad_option_kind", `line ${n}`, `an option's kind is stop or continue, not ${shown(kind)}`));
        continue;
      }
      options.push({ key: option[1] ?? "", label, kind });
      continue;
    }
    problems.push(problem("unknown_line", `line ${n}`, `${shown(line)} is no field of the card; the fields are Id, Outcome, Recommend, Options, Default and Risk`));
  }
  return { draft, problems };
}
