// The timeline's scroll rules (ADR-0008 phase D), pure and exhaustive so each case is tested. Design reference, not
// code: Signal-Desktop ts/util/timelineUtil.std.ts, which picks the scroll anchor in one function.
import { unreachable, type Message } from "@morndo/domain";

export type TimelineChange =
  | { kind: "loading" }
  | { kind: "opened"; divider: string | null }        // the conversation's messages arrived after it was opened
  | { kind: "focus"; id: string }                      // a message asked for (Show in chat)
  | { kind: "older" }                                  // older messages were put above
  | { kind: "newer"; atBottom: boolean }               // messages arrived below
  | { kind: "own" };                                   // the principal sent one

export type Anchor =
  | { kind: "none" }
  | { kind: "bottom" }
  | { kind: "message"; id: string; block: "start" | "center" }
  | { kind: "keep-in-place" };                         // the first message on screen stays exactly where it was

export function scrollAnchor(c: TimelineChange): Anchor {
  switch (c.kind) {
    case "loading": return { kind: "none" };
    case "opened": return c.divider ? { kind: "message", id: c.divider, block: "start" } : { kind: "bottom" };
    case "focus": return { kind: "message", id: c.id, block: "center" };
    case "older": return { kind: "keep-in-place" };
    case "newer": return c.atBottom ? { kind: "bottom" } : { kind: "none" };
    case "own": return { kind: "bottom" };
    default: return unreachable(c);
  }
}

// Where "New messages" goes: before the first message after the read mark that isn't the principal's own.
export function dividerBefore(messages: readonly Message[], readMark: number | null): string | null {
  if (readMark === null) return null;
  return messages.find(m => m.at > readMark && m.author.kind !== "principal")?.id ?? null;
}

// The jump-to-latest button shows once the bottom is more than one screen away.
export const showJump = (p: { scrollHeight: number; scrollTop: number; clientHeight: number }) =>
  p.scrollHeight - p.scrollTop - p.clientHeight > p.clientHeight;
