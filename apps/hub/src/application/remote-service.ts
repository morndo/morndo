// Application service for watching and controlling a worker's terminal or the office's desktop (AC9). It decides who
// may watch and who may control, and records control starting and ending; the streams are the adapters' (terminal.ts,
// rfb.ts). Input itself is never recorded.
import {
  DEFAULT_POLICY, controlHolds, endControl, grantControl, mayWatch,
  type AccessPolicy, type ControlGrant, type ControlTarget,
} from "@morndo/domain";
import type { DesktopTarget } from "../adapters/rfb.ts";
import type { Store } from "../adapters/store.ts";
import type { Authenticated } from "./access-service.ts";
import type { Terminal } from "./ports.ts";

export type Viewer = { target: ControlTarget; grant: ControlGrant | null; sessionId: string };
export type OpenRefusal = "ended" | "step_up" | "no_pane" | "no_desktop";

export class RemoteService {
  #store: Store;
  #policy: () => AccessPolicy;
  #now: () => number;
  #panes: () => string[];
  #desktop: () => DesktopTarget | null;
  readonly terminal: Terminal;

  constructor(p: {
    store: Store; terminal: Terminal; panes: () => string[]; desktop: () => DesktopTarget | null;
    policy?: () => AccessPolicy; now?: () => number;
  }) {
    this.#store = p.store;
    this.terminal = p.terminal;
    this.#panes = p.panes;
    this.#desktop = p.desktop;
    this.#policy = p.policy ?? (() => DEFAULT_POLICY);
    this.#now = p.now ?? Date.now;
  }

  desktop(): DesktopTarget | null { return this.#desktop(); }

  // A new watching or controlling connection. Control needs a fresh passkey check now (AC7, AC9).
  open(a: Authenticated, target: ControlTarget, control: boolean): { ok: true; viewer: Viewer } | { ok: false; refused: OpenRefusal } {
    const now = this.#now();
    if (target.kind === "terminal" && !this.#panes().includes(target.workerId)) return { ok: false, refused: "no_pane" };
    if (target.kind === "desktop" && !this.#desktop()) return { ok: false, refused: "no_desktop" };
    if (!control) return mayWatch(a.session, now, this.#policy()) ? { ok: true, viewer: { target, grant: null, sessionId: a.session.id } } : { ok: false, refused: "ended" };
    const g = grantControl(a.session, target, now, this.#policy());
    if (!g.ok) return { ok: false, refused: g.error };
    this.#store.record(g.value.events);
    return { ok: true, viewer: { target, grant: g.value.grant, sessionId: a.session.id } };
  }

  // Whether the connection may go on: its session still valid and, for control, the grant still holding.
  holds(v: Viewer, a: Authenticated | null): "ok" | "ended" | "lapsed" {
    const now = this.#now();
    if (!a || a.session.id !== v.sessionId || !mayWatch(a.session, now, this.#policy())) return "ended";
    if (v.grant && !controlHolds(v.grant, a.session, now, this.#policy())) return "lapsed";
    return "ok";
  }

  closed(v: Viewer, reason: "released" | "lapsed") {
    if (v.grant) this.#store.record([endControl(v.grant, reason, this.#now())]);
  }
}
