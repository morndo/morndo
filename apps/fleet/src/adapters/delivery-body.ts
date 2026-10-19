// The body of POST /v1/deliveries (fleet clients spec §8; plan Contracts, "Client API routes"): { id, lane | workerId
// (exactly one), text, ttlMs? }, its id, target, text and ttlMs checked against OP_ARGS["lane.deliver"] as the agent will
// (the id namespaced, at most 200 characters, no trailing "#<digits>"; the text 1 to 8000 characters): what doesn't fit
// is a body that doesn't fit, 400 (reconciliation ruling 3). Unknown fields are refused, so a client's typo never routes
// somewhere unintended. A deadline travels as a duration (ttlMs), never as a clock time (Review Focus 3): the node turns
// it into notAfter on its own clock.
import { LIMITS, OP_ARGS, parseBody } from "@morndo/protocol";
import type { DeliveryRequest } from "../application/deliveries.ts";

const FIELDS = new Set(["id", "lane", "workerId", "text", "ttlMs"]);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseDeliveryBody(v: unknown): { ok: true; body: DeliveryRequest } | { ok: false; message: string } {
  const no = (message: string) => ({ ok: false as const, message });
  if (!isObject(v)) return no("the body must be a JSON object");
  const extra = Object.keys(v).filter(k => !FIELDS.has(k));
  if (extra.length) return no(`unknown fields: ${extra.join(", ")}`);
  const targets = (["lane", "workerId"] as const).filter(k => v[k] !== undefined);
  if (targets.length !== 1) return no("name exactly one of lane or workerId");
  const t = targets[0] ?? "lane";
  const value = v[t];
  if (typeof value !== "string" || value === "" || value.length > 1000) return no(`${t} must be a non-empty string`);
  if (typeof v.id !== "string") return no("id must be a string");
  if (typeof v.text !== "string") return no("text must be a string");
  if (v.ttlMs !== undefined && !Number.isInteger(v.ttlMs)) return no("ttlMs must be a whole number of milliseconds");
  const base = { id: v.id, text: v.text, ...(v.ttlMs === undefined ? {} : { ttlMs: v.ttlMs as number }) };
  const target = t === "lane" ? { lane: value, sticky: false } : { workerId: value };
  if (parseBody(OP_ARGS["lane.deliver"], { ...base, target }) === null) return no(whyNot(base, t));
  return { ok: true, body: t === "lane" ? { ...base, lane: value } : { ...base, workerId: value } };
}

// Why lane.deliver's own rules refuse a body: the first field that breaks one, in words a client can act on.
function whyNot(b: { id: string; text: string; ttlMs?: number }, target: "lane" | "workerId"): string {
  if (!/^[a-z]{1,16}:./su.test(b.id)) return "id must start with the client's name (1 to 16 letters a-z) and a colon, then the id itself, such as \"kira:123\"";
  if (/\p{Cc}/u.test(b.id)) return "id must not hold a control character";
  if (b.id.length > LIMITS.maxDeliveryId) return `id is at most ${LIMITS.maxDeliveryId} characters, its client's name included`;
  if (/#\d+$/.test(b.id)) return "id must not end in \"#\" and digits: that is the key of a delivery's retype";
  if (!b.text) return "text is empty";
  if (b.text.length > LIMITS.maxSendText) return `text is at most ${LIMITS.maxSendText} characters`;
  if (b.ttlMs !== undefined && (b.ttlMs < 1 || b.ttlMs > LIMITS.deliveryKeepMs)) return `ttlMs is from 1 to ${LIMITS.deliveryKeepMs} (7 days)`;
  return target === "lane" ? "lane isn't a window name a lane can have" : "workerId isn't a worker ID (node.server.pane)";
}
