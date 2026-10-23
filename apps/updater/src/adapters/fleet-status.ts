// The node's FleetView adapter (updates §6.7, §7): what the node's own agent last heard from the fleet, from
// fleet-view.json beside its status.json. The updater may not import the agent, so the file is the contract —
// written by the agent, read here, validated by the same schema both sides share. A node asks the fleet for
// nothing beyond it: the node list is the control plane's skew gate's to ask (§7), so nodes() answers null and
// never throws, and the same code runs on both roles.
import { readFileSync } from "node:fs";
import { FleetViewFileSchema, parseBody } from "@morndo/protocol";
import type { FleetNode, FleetWord, FleetView } from "../application/ports.ts";
import { pidAlive } from "./probes.ts";

// This machine's name in the fleet (§7, RL12): the node name its own agent reports in status.json — read without
// the probe's freshness or pid gates, because a rollback can outlive the agent that wrote it (a restarted agent
// has a new pid; the name is durable). A machine whose agent says nothing is the control plane.
// The node this machine's own agent is right now, for the control plane's skew gate (§7): its name only while that
// agent is alive (its pid answers) and online under it — the fleet admitted this machine's key for the name. A
// status.json an exited or refused agent left behind names nobody: the name may since be another machine's
// (review of #116), and counting a node is the safe side. Same-user writable, as everything here (ADR-0004).
export function ownOnlineNodeOf(nodeStatusPath: string): string | null {
  try {
    const s = JSON.parse(readFileSync(nodeStatusPath, "utf8")) as { node?: unknown; state?: unknown; pid?: unknown };
    if (typeof s.node !== "string" || s.node.length === 0 || s.state !== "online") return null;
    return typeof s.pid === "number" && Number.isInteger(s.pid) && s.pid > 0 && pidAlive(s.pid) ? s.node : null;
  } catch {
    return null;
  }
}

export function machineNameOf(nodeStatusPath: string): string {
  try {
    const node = (JSON.parse(readFileSync(nodeStatusPath, "utf8")) as { node?: unknown }).node;
    return typeof node === "string" && node.length > 0 ? node : "control-plane";
  } catch {
    return "control-plane";
  }
}

export class FleetStatusView implements FleetView {
  readonly #path: string;

  constructor(o: { path: string }) {
    this.#path = o.path;
  }

  // Missing, unreadable or not the wire's shape: no word (null), never a guess — the gate treats that as its own
  // refusal (no_view), so a node cut off from its agent never applies on a memory.
  async view(): Promise<FleetWord | null> {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(this.#path, "utf8")); }
    catch { return null; }
    return parseBody(FleetViewFileSchema, raw);
  }

  // A node does not ask the fleet for its nodes (§7): the skew gate is the control plane's own, over the socket.
  async nodes(): Promise<FleetNode[] | null> { return null; }
}
