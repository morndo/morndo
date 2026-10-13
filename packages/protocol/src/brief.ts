// A decision brief on the wire (ADR-0023, design §4.5): the brief a decision item was filed from, as the hub stores
// it. The hub lints a brief when it is filed (the domain's lintBrief), so this reads shape only, at no limits of its
// own; a brief this app can't parse is null, never a half brief, and the card falls back to the plain fields. The
// committed JSON Schema of this shape (schema/decision-brief.json) is what an engine files by tool call.
import type { DecisionBrief } from "@morndo/domain";
import * as z from "./z.ts";

const text = () => z.string();                                           // hub → app: any length
// zod's catch, named so it isn't taken for Promise.catch: a value this build doesn't know reads as the fallback.
const orElse = z.catch;

export const DecisionBriefSchema = z.object({
  topic: text(),
  due: z.number(),
  minutes: z.number(),
  headline: text(),
  recommend: text(),
  ask: z.object({ text: text(), alternative: text(), uncertainty: text() }),
  whyNow: text(),
  options: z.array(z.object({ key: text(), label: text() })),
  comparison: z.object({
    rows: z.array(z.object({ factor: text(), cells: z.array(text()) })),
    note: text(),
  }),
  why: z.object({ text: text(), assumptions: z.array(text()), downside: text() }),
  changeIf: text(),
  risk: z.object({ risk: text(), control: text() }),
  authorizes: z.object({ limits: z.array(text()), freshApproval: text(), reviewPoint: text() }),
  ifNoAnswer: z.nullable(text()),
  evidence: z.array(z.object({ label: text(), url: text() })),
  // A hub from before a part, or a value this build doesn't know: the safe reading.
  blocking: orElse(z.boolean(), false),
  project: orElse(z.nullable(text()), null),
  task: orElse(z.nullable(text()), null),
  ref: orElse(z.nullable(text()), null),
});

// The decoded shape is the domain's own (checked at compile time): a decoded brief is used as it is.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const check = <T extends true>(t: T) => t;
check<Same<z.output<typeof DecisionBriefSchema>, DecisionBrief>>(true);
