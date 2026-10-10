// The Engines page's two calls (ADR-0013): GET /api/engines, what the engine layer's CLI reports, and POST
// /api/engines, the changes a save writes through it. Types are the domain's own.
import type { EngineProvider, RoleEngines } from "@morndo/domain";
import * as z from "./z.ts";

const text = (max: number) => z.string().check(z.maxLength(max));

// What runs a role now, by the resolver: the engine it would pick (null: nothing in the chain is available) and why the
// ones before it were skipped, in its own words.
export type EnginesNow = { engine: string | null; skipped: { engine: string; reason: string }[] };

export type EnginesView = {
  // The settings as they were read, as a fingerprint: a save sent against another one is refused with 409 "changed",
  // so the page never writes over a change made elsewhere (the CLI, the manager) since it loaded.
  version: string;
  // The engine layer's kill switch (`engines option enabled`): while off, lanes run as before and nothing here applies.
  enabled: boolean;
  roles: (RoleEngines & { now: EnginesNow })[];
  providers: EngineProvider[];
};

// One change per role: its whole chain in order (engine text, "provider:model[@effort]"), its other-provider rule, or both.
export const EnginesSaveBody = z.object({
  version: text(128),
  changes: z.array(z.object({
    role: text(64),
    // No length cap here: the limit on a chain is the domain's MAX_CHAIN, where a role set longer by hand may keep its
    // length and a refusal names the role (verify round, finding 6). The hub's 64 KB body limit bounds the size.
    chain: z.exactOptional(z.array(text(200))),
    otherProvider: z.exactOptional(z.boolean()),
  })).check(z.minLength(1), z.maxLength(32)),
});
export type EnginesSaveBody = z.output<typeof EnginesSaveBody>;
