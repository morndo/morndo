// What this node reports (spec §4, §5.4): the panes of the policy's tmux session that are alone in their window (a lane
// is one window with one pane), each under its worker ID `<node>.<server stamp>.<pane>`, with the Claude Code session
// running there. The stamp is read in the same tmux command as the panes, so a list never mixes two servers; a server
// without a stamp (new, or restarted) is stamped and read again. `invVersion` grows whenever what is reported changes,
// within this agent process. Refreshes run one at a time, so each sees every change made before it was asked for.
import { formatWorkerId, type Pane } from "@morndo/protocol";
import type { SessionInfo } from "@morndo/node-ops";
import { listPanes, type PaneRow } from "./tmux-panes.ts";

export type InventoryDeps = {
  node: string;
  session: string;
  socket: string | null;
  sessions: () => Map<string, SessionInfo>;
  stamp: (socket: string | null) => Promise<string | null>;
};
export type Lane = { workerId: string; pane: string; windowId: string; window: string; sessionId: string | null };
export type Snapshot = { invVersion: number; stamp: string | null; panes: Pane[]; lanes: Lane[]; rows: PaneRow[] };

export class Inventory {
  #d: InventoryDeps;
  #snap: Snapshot = { invVersion: 0, stamp: null, panes: [], lanes: [], rows: [] };
  #reported = "[]";
  #chain: Promise<unknown> = Promise.resolve();
  #readAt = Number.NEGATIVE_INFINITY;                    // performance.now() when the snapshot was last read

  constructor(d: InventoryDeps) { this.#d = d; }

  get invVersion(): number { return this.#snap.invVersion; }
  last(): Snapshot { return this.#snap; }

  refresh(): Promise<Snapshot> {
    const next = this.#chain.then(() => this.#read());
    this.#chain = next.catch(() => undefined);
    return next;
  }

  // The snapshot, read again only when it is older than `maxAgeMs`: the agent reads it every inventoryPollMs anyway, so a
  // caller that asks often (the hub's capture of its panes every poll) needn't spawn tmux and scan the sessions each time.
  current(maxAgeMs: number): Promise<Snapshot> {
    return performance.now() - this.#readAt <= maxAgeMs ? Promise.resolve(this.#snap) : this.refresh();
  }

  windowOfPane(pane: string): string | null {
    return this.#snap.rows.find(r => r.pane === pane)?.window ?? null;
  }

  async #read(): Promise<Snapshot> {
    const d = this.#d;
    let rows = await listPanes(d.socket, d.session);
    if (rows.length && rows.some(r => !r.stamp)) {
      await d.stamp(d.socket);
      rows = await listPanes(d.socket, d.session);
    }
    const stamp = rows[0]?.stamp || null;
    const sessions = d.sessions();
    const lanes: Lane[] = [];
    const panes: Pane[] = [];
    for (const r of rows) {
      if (r.windowPanes !== 1 || !r.stamp) continue;
      const s = sessions.get(r.pane);
      const workerId = formatWorkerId({ node: d.node, server: r.stamp, pane: r.paneNum });
      lanes.push({ workerId, pane: r.pane, windowId: r.windowId, window: r.window, sessionId: s?.sessionId ?? null });
      panes.push({
        workerId, window: r.window, cwd: r.cwd,
        ...(s ? { sessionId: s.sessionId } : {}),
        ...(s?.name ? { sessionName: s.name } : {}),
        ...(r.title !== null ? { title: r.title } : {}),
        ...(s?.version ? { claudeVersion: s.version } : {}),
      });
    }
    const reported = JSON.stringify(panes);
    const invVersion = reported === this.#reported ? this.#snap.invVersion : this.#snap.invVersion + 1;
    this.#reported = reported;
    this.#snap = { invVersion, stamp, panes, lanes, rows };
    this.#readAt = performance.now();
    return this.#snap;
  }
}
