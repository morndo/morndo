// Which window a hook came from (spec §5.5, "Identity in each event"): the pane named by TMUX_PANE in its body, else the
// pane its session_id runs in (the session registry), and then that pane's window in the latest inventory. When neither
// leads anywhere (a `lanes notify` from outside a pane, a lane's first turn ending before the registry lists it), the
// body's own `window`, a window name (1 to 200 characters, no control character; fleet clients spec §6), else null.
import type { SessionInfo } from "@morndo/node-ops";

// A tmux pane id ("%3"), as a hook body names it in TMUX_PANE.
const PANE_ID = /^%\d{1,9}$/;

// A session is named by its id, or by an alias: an engine lane's hooks name it as its file does (SessionInfo.aliases), which changes
// when the engine names a session. A session_id the read doesn't know asks `refresh` for a read that is at most REFRESH_MS old,
// and the same id does so only once in ID_REFRESH_MS: a session with no pane (outside tmux) posts all the time, and each of its
// hooks would read the registry again.
export function windowResolver(o: {
  windowOfPane(pane: string): string | null; sessions(): Map<string, SessionInfo>; refresh?: () => Map<string, SessionInfo>; now?: () => number;
}): (body: unknown) => string | null {
  const now = o.now ?? (() => performance.now());
  const asked = new Map<string, number>();                           // unknown session_id → when it last asked for a newer read
  const find = (sessions: Map<string, SessionInfo>, id: string) => {
    for (const [pane, s] of sessions) if (s.sessionId === id || s.aliases?.includes(id)) return pane;
    return null;
  };
  const refreshFor = (id: string) => {
    const last = asked.get(id);
    if (!o.refresh || (last !== undefined && now() - last < ID_REFRESH_MS)) return null;
    if (asked.size >= ASKED_MAX) asked.clear();
    asked.set(id, now());
    return find(o.refresh(), id);
  };
  return body => {
    if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
    const b = body as Record<string, unknown>;
    if (typeof b.TMUX_PANE === "string" && PANE_ID.test(b.TMUX_PANE)) return o.windowOfPane(b.TMUX_PANE);
    if (typeof b.session_id === "string") {
      const pane = find(o.sessions(), b.session_id) ?? refreshFor(b.session_id);
      if (pane !== null) return o.windowOfPane(pane);
    }
    return typeof b.window === "string" && /^[^\p{Cc}]{1,200}$/u.test(b.window) ? b.window : null;
  };
}

export const REFRESH_MS = 250;
const ID_REFRESH_MS = 5000;
const ASKED_MAX = 512;

// A read kept for a while: `get()` reads again once the last read is `ms` old; `fresh()` once it is REFRESH_MS old, or `ms` if that
// is shorter, so it is never staler than `get()`. /sl arrives often, and each read lists ~/.claude/sessions.
export function cachedFor<T>(ms: number, read: () => T, now: () => number = () => performance.now()): (() => T) & { fresh: () => T } {
  let at = -Infinity;
  let value: T | undefined;
  const readIfOlderThan = (limit: number): T => {
    if (value === undefined || now() - at >= limit) { value = read(); at = now(); }
    return value;
  };
  return Object.assign(() => readIfOlderThan(ms), { fresh: () => readIfOlderThan(Math.min(REFRESH_MS, ms)) });
}

// B6: a Stop from a session that is not the one registered for the pane it names (a headless run started inside a lane's
// pane inherits its TMUX_PANE, and would end the lane's turn). Unknown is never foreign: a pane with no registered session,
// a body without a pane or a session. The registry may be a moment behind (/clear, a resume), so a mismatch reads it again
// once, as windowResolver does for an unknown id.
export function foreignStop(o: { sessions(): Map<string, SessionInfo>; refresh?: () => Map<string, SessionInfo> }): (body: unknown) => boolean {
  const named = (s: SessionInfo, id: string) => s.sessionId === id || (s.aliases?.includes(id) ?? false);
  return body => {
    if (body === null || typeof body !== "object" || Array.isArray(body)) return false;
    const b = body as Record<string, unknown>;
    if (typeof b.TMUX_PANE !== "string" || !PANE_ID.test(b.TMUX_PANE) || typeof b.session_id !== "string") return false;
    const own = o.sessions().get(b.TMUX_PANE);
    if (own === undefined || named(own, b.session_id)) return false;
    const fresh = (o.refresh ? o.refresh() : o.sessions()).get(b.TMUX_PANE);
    return fresh !== undefined && !named(fresh, b.session_id);
  };
}
