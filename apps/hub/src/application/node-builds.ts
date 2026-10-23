// The fleet's nodes and the commit each one's build reports (B11), asked on an interval and kept as the last listing
// that answered. A node that reports a commit is on it. A report with no commit is read by the node's status: offline,
// it is the fleet's last word about a node it can't see now, so the last commit still counts; online or stale — or with
// no status at all — it is the node's own current word, so the build is unknown and the remembered commit is dropped. A
// node the listing no longer names is forgotten, and a fleet that doesn't answer keeps the board as it was. Failing
// closed is the liveness step's job; nothing here throws.
import type { NodeBuild } from "@morndo/domain";

const BUILD_COMMIT = /^[0-9a-f]{40}$/;

export class NodeBuilds {
  readonly #source: () => Promise<readonly { name: string; commit?: string | null; status?: string }[]>;
  readonly #everyMs: number;
  readonly #log: { warn(msg: string, e?: unknown): void } | undefined;
  #builds: readonly NodeBuild[] = [];
  #lastCommit = new Map<string, string>();      // a node's last real commit, for a listing that names it without one
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #failing = false;                             // a failed listing warns once per streak, not once per poll

  constructor(o: { source: () => Promise<readonly { name: string; commit?: string | null; status?: string }[]>; everyMs?: number; log?: { warn(msg: string, e?: unknown): void } }) {
    this.#source = o.source;
    this.#everyMs = o.everyMs ?? 15_000;
    this.#log = o.log;
  }

  // One listing. A failure keeps the previous list and warns once per streak.
  async refresh(): Promise<void> {
    if (this.#stopped) return;
    let listed: readonly { name: string; commit?: string | null; status?: string }[];
    try { listed = await this.#source(); }
    catch (e) {
      if (!this.#failing) this.#log?.warn("node builds: listing the fleet's nodes failed; keeping the last list", e);
      this.#failing = true;
      return;
    }
    if (this.#stopped) return;                  // stopped while the listing was being awaited
    this.#failing = false;
    const next: NodeBuild[] = [];
    const named = new Set<string>();
    for (const n of listed) {
      const commit = typeof n.commit === "string" && BUILD_COMMIT.test(n.commit) ? n.commit : null;
      if (commit !== null) this.#lastCommit.set(n.name, commit);
      else if (n.status !== "offline") this.#lastCommit.delete(n.name);   // a live report of no commit: unknown, not the last one
      named.add(n.name);
      next.push({ node: n.name, commit: commit ?? this.#lastCommit.get(n.name) ?? null });
    }
    for (const name of this.#lastCommit.keys()) if (!named.has(name)) this.#lastCommit.delete(name);
    this.#builds = next;
  }

  start() {
    void this.refresh();
    this.#timer = setInterval(() => void this.refresh(), this.#everyMs);
    this.#timer.unref?.();
  }
  stop() { this.#stopped = true; if (this.#timer) clearInterval(this.#timer); this.#timer = null; }

  list(): NodeBuild[] { return [...this.#builds]; }
}
