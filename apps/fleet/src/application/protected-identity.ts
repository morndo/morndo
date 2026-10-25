// What the fleet remembers of a protected lane (T-440). A worker ID and a session seen under a protected window name
// stay protected after that window is renamed, and so does every working directory that worker was seen in. Memory
// only: nothing remembered here is dropped.
import { parseWorkerId, type Pane } from "@morndo/protocol";
import { normalize } from "node:path/posix";

export class ProtectedIdentity {
  readonly #names: ReadonlySet<string>;
  readonly #workers = new Set<string>();
  readonly #sessions = new Set<string>();
  // Every working directory seen for a protected worker, on the node its worker ID names: a session's files live under
  // the directory it started in, so a lane that moved on keeps its first one protected too.
  readonly #cwds = new Map<string, { node: string; cwd: string }>();

  constructor(names: ReadonlySet<string>) { this.#names = names; }

  observe(panes: readonly Pane[]): void {
    for (const pane of panes) {
      // A pane whose window is a protected name, or whose worker ID is already remembered, is protected.
      if (!this.#names.has(pane.window) && !this.#workers.has(pane.workerId)) continue;
      this.#workers.add(pane.workerId); // remember its worker ID
      if (pane.sessionId !== undefined && pane.sessionId !== "") this.#sessions.add(pane.sessionId); // remember its session, when it has one
      const node = parseWorkerId(pane.workerId)?.node;
      if (node === undefined) continue; // skip the cwd when the node cannot be parsed
      if (pane.cwd === "") continue; // skip an empty cwd
      this.#cwds.set(`${node}\n${pane.cwd}`, { node, cwd: pane.cwd }); // remember its (node, cwd); earlier ones stay
    }
  }

  // Remember the worker ID of each lane whose name is protected (a fleet that restarts still has the registry's rows).
  seed<T extends { name: string; node: string; workerId: string | null }>(lanes: readonly T[]): void {
    for (const lane of lanes) if (this.#names.has(lane.name) && lane.workerId !== null) this.#workers.add(lane.workerId);
  }

  hasWorker(id: string): boolean { return this.#workers.has(id); }
  hasSession(id: string): boolean { return this.#sessions.has(id); }

  isProtectedPath(node: string, path: string): boolean {
    const p = normalize(path); // compare the normalized path
    for (const session of this.#sessions) if (p.includes(session)) return true; // true when it contains a remembered session ID
    for (const seen of this.#cwds.values()) {
      if (seen.node !== node) continue; // a remembered cwd counts only on the node it was seen on
      const cwd = seen.cwd;
      if (p === cwd || p.startsWith(`${cwd}/`)) return true; // the working directory itself, or a path inside it
      const enc = cwd.replace(/[^a-zA-Z0-9]/g, "-"); // Claude Code's project directory names the cwd with every other character as "-"
      const marker = `/projects/${enc}`;
      if (p.includes(`${marker}/`) || p.endsWith(marker)) return true; // that project directory, or a file inside it
    }
    return false; // anything else is not a protected path
  }
}
