// The bodies of the rollout routes (updates design §7; plan Contracts, "Client API routes"): each names its Version
// as the wire spells it (releases.ts' SEMVER), committed may name its soak (0 to 10,080 minutes, RolloutWire's
// bound), halt names the machine that stopped it (a node name) and why (1 to 200 characters, no control character —
// what the wire's haltReason holds). Unknown fields are refused, so a client's typo never routes somewhere
// unintended (delivery-body's rule).
import { NODE_NAME, SEMVER } from "@morndo/protocol";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const FIELDS = { committed: new Set(["version", "soakMinutes"]), halt: new Set(["version", "machine", "reason"]), resume: new Set(["version"]) } as const;

export type RolloutBody =
  | { ok: true; kind: "committed"; version: string; soakMinutes?: number }
  | { ok: true; kind: "halt"; version: string; machine: string; reason: string }
  | { ok: true; kind: "resume"; version: string };

export function parseRolloutBody(kind: "committed" | "halt" | "resume", v: unknown): RolloutBody | { ok: false; message: string } {
  const no = (message: string) => ({ ok: false as const, message });
  if (!isObject(v)) return no("the body must be a JSON object");
  const extra = Object.keys(v).filter(k => !FIELDS[kind].has(k));
  if (extra.length) return no(`unknown fields: ${extra.join(", ")}`);
  if (typeof v.version !== "string" || !SEMVER.test(v.version) || v.version.includes("+"))
    return no("version must be a Release's Version without build metadata, such as 0.4.2");
  if (kind === "resume") return { ok: true, kind, version: v.version };
  if (kind === "committed") {
    const soak = v.soakMinutes;
    if (soak !== undefined && (typeof soak !== "number" || !Number.isInteger(soak) || soak < 0 || soak > 10_080))
      return no("soakMinutes must be a whole number of minutes from 0 to 10,080 (a week)");
    return { ok: true, kind, version: v.version, ...(soak === undefined ? {} : { soakMinutes: soak }) };
  }
  if (typeof v.machine !== "string" || !NODE_NAME.test(v.machine)) return no("machine must be the node name whose rollback or owner stopped it");
  if (typeof v.reason !== "string" || !/^[^\p{Cc}]{1,200}$/u.test(v.reason)) return no("reason must be 1 to 200 characters and no control character");
  return { ok: true, kind, version: v.version, machine: v.machine, reason: v.reason };
}
