// The control plane's FleetView adapter (updates §4.5, §7): the Rollout and the fleet's own node list, told over
// the fleet's Unix socket — and nothing else, for the write routes are closed (§4.3): the updater's word out is
// its state file, which the fleet reads itself. The updater is a client of the fleet like any other, named in
// x-morndo-client. Every answer that is not the fleet's own 200 is a null — never a throw — because the caller's
// contract is "the apply waits", not "fail the walk".
import { request, type RequestOptions } from "node:http";
import { FleetViewFileSchema, parseBody } from "@morndo/protocol";
import type { Clock, FleetNode, FleetWord, FleetView } from "../application/ports.ts";

const TIMEOUT_MS = 5_000;
const ANSWER_CAP = 64 * 1024;    // the same cap every fleet answer gets: a host that answers endlessly answers nothing

const decodeText = new TextDecoder();

// One HTTP exchange over the socket, whole and inside the wall, or null: the fleet was not there to ask.
const exchange = (o: {
  socketPath: string; path: string; method: "GET" | "POST"; body?: string; timeoutMs: number;
}): Promise<{ status: number; body: string } | null> =>
  new Promise(resolve => {
    let settled = false;
    let overdue: ReturnType<typeof setTimeout> | null = null;
    const answer = (r: { status: number; body: string } | null): void => {
      if (settled) return;
      settled = true;
      if (overdue !== null) clearTimeout(overdue);
      resolve(r);
    };
    const headers: Record<string, string> = { "x-morndo-client": "updater" };
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const options: RequestOptions = { socketPath: o.socketPath, path: o.path, method: o.method, headers };
    const req = request(options, res => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      res.on("data", (chunk: Uint8Array) => {
        size += chunk.byteLength;
        if (size > ANSWER_CAP) { answer(null); req.destroy(); return; }
        chunks.push(chunk);
      });
      res.on("end", () => answer({ status: res.statusCode ?? 0, body: decodeText.decode(Buffer.concat(chunks)) }));
      res.on("error", () => answer(null));
    });
    overdue = setTimeout(() => { answer(null); req.destroy(); }, o.timeoutMs);
    req.on("error", () => answer(null));
    req.end(o.body ?? "");
  });

export class FleetSocketView implements FleetView {
  readonly #socketPath: string;
  readonly #clock: Pick<Clock, "now">;
  readonly #timeoutMs: number;

  constructor(o: { socketPath: string; clock: Pick<Clock, "now">; timeoutMs?: number }) {
    this.#socketPath = o.socketPath;
    this.#clock = o.clock;
    this.#timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  }

  // GET /v1/rollout, taken field by field and stamped with the moment it was heard: the answer carries
  // `aboveControlPlane` beside the agent's view's own fields, and this machine is no agent — it is offered
  // nothing (the offer is the fleet's word to a node), so `offer` is null by construction here.
  async view(): Promise<FleetWord | null> {
    const answer = await exchange({
      socketPath: this.#socketPath, path: "/v1/rollout", method: "GET", timeoutMs: this.#timeoutMs,
    });
    if (answer === null || answer.status !== 200) return null;
    try {
      const said = JSON.parse(answer.body) as { controlPlane?: unknown; rollout?: unknown };
      return parseBody(FleetViewFileSchema, {
        observedAt: this.#clock.now(), controlPlane: said.controlPlane ?? null, rollout: said.rollout ?? null, offer: null,
      });
    } catch {
      return null;
    }
  }

  // GET /v1/nodes (§5.1): every node the fleet keeps, none revoked (the route itself refuses those), each with the
  // protocols its agent speaks — the highest of them is the skew gate's word (RL11), null when the node never said.
  async nodes(): Promise<FleetNode[] | null> {
    const answer = await exchange({
      socketPath: this.#socketPath, path: "/v1/nodes", method: "GET", timeoutMs: this.#timeoutMs,
    });
    if (answer === null || answer.status !== 200) return null;
    let rows: unknown;
    try { rows = JSON.parse(answer.body); } catch { return null; }
    if (!Array.isArray(rows)) return null;
    const nodes: FleetNode[] = [];
    for (const row of rows) {
      if (typeof row !== "object" || row === null) return null;
      const { name, proto } = row as { name?: unknown; proto?: unknown };
      if (typeof name !== "string") return null;
      const list = Array.isArray(proto) && proto.every(p => typeof p === "number") ? proto as number[] : null;
      nodes.push({
        name,
        agentProtocol: list !== null && list.length > 0 ? Math.max(...list) : null,
        joined: true,
        revoked: false,
      });
    }
    return nodes;
  }
}
