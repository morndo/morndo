// What an updater reads from outside a service (design: releases and updates, sections 5 and 6.4).
// The shapes are strict where the service writes them; a node's status file keeps the fields it already had.
import * as z from "./z.ts";

// SemVer 2.0.0 (https://semver.org/, checked 2026-10-11): major.minor.patch, optional pre-release and build.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const ProductVersion = z.string().check(z.regex(SEMVER));

export const ServiceName = z.enum(["hub", "fleet", "node"]);
export type ServiceName = z.infer<typeof ServiceName>;
export const HoldReason = z.enum(["drain", "probation"]);
export type HoldReason = z.infer<typeof HoldReason>;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

// ~/.local/state/morndo-update/hold.json. Unknown fields are refused: a typo must not look like a hold.
export const HoldFile = z.strictObject({
  services: z.array(ServiceName).check(z.minLength(1), z.maxLength(3)),
  reason: HoldReason,
  version: ProductVersion,
  since: z.string().check(z.regex(ISO_TIME)),
});
export type HoldFile = z.infer<typeof HoldFile>;

export const InFlightItem = z.strictObject({
  kind: z.string().check(z.minLength(1), z.maxLength(64)),
  id: z.string().check(z.minLength(1), z.maxLength(200)),
});
export type InFlightItem = z.infer<typeof InFlightItem>;

// Hub GET /api/health and fleet GET /v1/health, read on the machine itself.
export const ServiceHealth = z.strictObject({
  version: ProductVersion,
  schema: z.number().check(z.int(), z.gte(0)),
  ready: z.boolean(),
  inFlight: z.array(InFlightItem).check(z.maxLength(100)),
});
export type ServiceHealth = z.infer<typeof ServiceHealth>;

// A hub health request that came through the network proxy, with no session: ready, and nothing else.
export const ReadyOnlyHealth = z.strictObject({ ready: z.boolean() });

// The agent's status.json: version, ready, and the fleet connection state, plus the fields it already writes.
// inFlight is optional: an older agent's status file has none, and an updater reading one then answers no_answer for
// the node's safe point — it cannot vouch that nothing is in flight — instead of guessing quiet.
export const NodeStatusHealth = z.looseObject({
  version: ProductVersion,
  ready: z.boolean(),
  state: z.enum(["stopped", "connecting", "online", "backoff", "refused", "conflict", "unsupported"]),
  inFlight: z.exactOptional(z.array(InFlightItem).check(z.maxLength(100))),
});
export type NodeStatusHealth = z.infer<typeof NodeStatusHealth>;
