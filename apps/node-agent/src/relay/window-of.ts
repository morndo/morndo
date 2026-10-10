// Which window a hook came from (spec §5.5, "Identity in each event"): the pane named by TMUX_PANE in its body, else the
// pane its session_id runs in (the session registry), and then that pane's window in the latest inventory. Null when
// neither leads anywhere.
import type { SessionInfo } from "@morndo/node-ops";

export function windowResolver(o: { windowOfPane(pane: string): string | null; sessions(): Map<string, SessionInfo> }): (body: unknown) => string | null {
  return body => {
    if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
    const b = body as Record<string, unknown>;
    if (typeof b.TMUX_PANE === "string" && /^%\d{1,9}$/.test(b.TMUX_PANE)) return o.windowOfPane(b.TMUX_PANE);
    if (typeof b.session_id === "string") {
      for (const [pane, s] of o.sessions()) if (s.sessionId === b.session_id) return o.windowOfPane(pane);
    }
    return null;
  };
}

// The registry read at most once per `ms`: /sl arrives often, and each read lists ~/.claude/sessions.
export function cachedFor<T>(ms: number, read: () => T, now: () => number = () => performance.now()): () => T {
  let at = -Infinity;
  let value: T | undefined;
  return () => {
    if (value === undefined || now() - at >= ms) { value = read(); at = now(); }
    return value;
  };
}
