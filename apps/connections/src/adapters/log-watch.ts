// The log matcher of `keypool watch` (ADR-0037, slice 4; plan 3.6). A server's log holds anyone's words, so only the classifier's two exhausted phrases act
// (the credit balance, the specified usage limits); a hold or a refused key in a log stays the owner's to find. A verdict is a word, never a part of the line.
// A line is looked at up to LINE_LIMIT characters; the rest of a longer line is dropped as it arrives, never buffered.
import { CREDIT, SPEND } from "./outcome-anthropic.ts";
import { streamRedactor } from "./redact.ts";

export type Verdict = "exhausted-credit" | "exhausted-spend" | "none";
export const LINE_LIMIT = 8192;

export function lineVerdict(line: string): Verdict {
  const seen = line.length > LINE_LIMIT ? line.slice(0, LINE_LIMIT) : line;
  if (CREDIT.test(seen)) return "exhausted-credit";
  if (SPEND.test(seen)) return "exhausted-spend";
  return "none";
}

// Chunks in, the verdicts of the lines they complete out. A partial line waits for its newline; once a line is past the limit its tail is skipped.
export function lineScanner(): { push(chunk: string): Verdict[]; buffered(): number } {
  let held = "";
  let skipping = false;
  return {
    push(chunk: string): Verdict[] {
      const verdicts: Verdict[] = [];
      let rest = chunk;
      for (;;) {
        const at = rest.indexOf("\n");
        const part = at < 0 ? rest : rest.slice(0, at);
        if (!skipping) {
          held += part;
          if (held.length > LINE_LIMIT) { held = held.slice(0, LINE_LIMIT); skipping = true; }
        }
        if (at < 0) return verdicts;
        const verdict = lineVerdict(held);
        if (verdict !== "none") verdicts.push(verdict);
        held = "";
        skipping = false;
        rest = rest.slice(at + 1);
      }
    },
    buffered: () => held.length,
  };
}

// What the command prints passes the exact-value filter: text is held to its line end, then written with every secret replaced.
export function redactingWriter(write: (text: string) => void, secrets: readonly string[]): (text: string) => void {
  const redactor = streamRedactor(secrets);
  let line = "";
  return (text: string): void => {
    line += text;
    const end = line.lastIndexOf("\n");
    if (end < 0) return;
    const whole = line.slice(0, end + 1);
    line = line.slice(end + 1);
    write(redactor.push(whole) + redactor.flush());
  };
}
