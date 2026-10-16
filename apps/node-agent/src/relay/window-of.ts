// Which window a hook came from (spec §5.5, "Identity in each event"): the pane named by TMUX_PANE in its body, else the
// pane its session_id runs in (the session registry), and then that pane's window in the latest inventory. When neither
// leads anywhere (a `lanes notify` from outside a pane, a lane's first turn ending before the registry lists it), the
// body's own `window`, a window name (1 to 200 characters, no control character; fleet clients spec §6), else null.
import type { SessionInfo } from "@morndo/node-ops";

// A session is named by its id, or by an alias: an engine lane's hooks name it as its file does (SessionInfo.aliases), which changes
// when the engine names a session. A session_id the read doesn't know asks `refresh` for a read that is at most REFRESH_MS old.
export function windowResolver(o: { windowOfPane(pane: string): string | null; sessions(): Map<string, SessionInfo>; refresh?: () => Map<string, SessionInfo> }): (body: unknown) => string | null {
  const find = (sessions: Map<string, SessionInfo>, id: string) => {
    for (const [pane, s] of sessions) if (s.sessionId === id || s.aliases?.includes(id)) return pane;
    return null;
  };
  return body => {
    if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
    const b = body as Record<string, unknown>;
    if (typeof b.TMUX_PANE === "string" && /^%\d{1,9}$/.test(b.TMUX_PANE)) return o.windowOfPane(b.TMUX_PANE);
    if (typeof b.session_id === "string") {
      const pane = find(o.sessions(), b.session_id) ?? (o.refresh ? find(o.refresh(), b.session_id) : null);
      if (pane !== null) return o.windowOfPane(pane);
    }
    return typeof b.window === "string" && /^[^\p{Cc}]{1,200}$/u.test(b.window) ? b.window : null;
  };
}

export const REFRESH_MS = 250;

// The registry read at most once per `ms`: /sl arrives often, and each read lists ~/.claude/sessions. `fresh()` reads it again
// unless the last read is less than REFRESH_MS old.
export function cachedFor<T>(ms: number, read: () => T, now: () => number = () => performance.now()): (() => T) & { fresh: () => T } {
  let at = -Infinity;
  let value: T | undefined;
  const get = () => {
    if (value === undefined || now() - at >= ms) { value = read(); at = now(); }
    return value;
  };
  return Object.assign(get, {
    fresh: () => {
      if (value === undefined || now() - at >= REFRESH_MS) { value = read(); at = now(); }
      return value;
    },
  });
}
