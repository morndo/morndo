// Which period a plan's own name says its windows run on (plan 4.1 item 3, U7): a window with no length of its own
// is titled from the reset horizon when the plan's family says the period, and from the gap between two observed
// resets when the name sits on both periods. The words are the plans' own: a name saying `free`, `plus`, `premium`
// or `super` is a weekly-period plan; one saying `ultra` is a name on both periods (its windows stay "plan period"
// until two observed resets say which); any other name, or none, says nothing.
import type { PlanFamily } from "./usage-title.ts";

const WEEKLY_WORDS = ["free", "plus", "premium", "super"];
const EITHER_WORDS = ["ultra"];

export function planFamilyOf(plan: string | null): PlanFamily | null {
  if (plan === null) return null;
  const words = plan.toLowerCase().split(/[^a-z]+/).filter(w => w !== "");
  if (words.some(w => EITHER_WORDS.includes(w))) return "either";
  if (words.some(w => WEEKLY_WORDS.includes(w))) return "weekly";
  return null;
}
