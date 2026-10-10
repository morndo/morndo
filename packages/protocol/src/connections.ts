// LLM connections on the wire (ADR-0018). Metadata only: a key's ref and fingerprint, never the secret.
// The words table is the one the CLI and the page both use. The vendor catalog is data (catalog/vendors.json).
import * as z from "./z.ts";

const text = (max: number) => z.string().check(z.minLength(1), z.maxLength(max));
const name = () => z.string().check(z.regex(/^[a-z][a-z0-9-]*$/), z.maxLength(64));

export const CONNECTION_WORDS = {
  title: "LLM connections",
  sections: { connections: "Connections", priority: "Priority", roles: "Roles" },
  add: "Add connection",
  kinds: { subscription: "Subscription", "api-key": "API key" },
  modes: {
    "subscriptions-first": "Subscriptions first, keys as overflow",
    "keys-first": "API keys first",
    "subscriptions-only": "Subscriptions only",
    "keys-only": "API keys only",
    custom: "Custom order",
  },
  overrides: { follow: "Follow", own: "Own order", hand: "Hand" },
  status: { on: "On", off: "Off", revoked: "Revoked" },
  availability: {
    ready: "Ready", off: "Off", revoked: "Revoked", terms: "Terms not read",
    expired: "Expired", budget: "Out of budget", unarmed: "Provider off until terms are read",
  },
  drift: "Changed outside Morndo",
  reapply: "Re-apply",
  keepHand: "Keep as hand",
  alerts: "Alerts",
  empty: "None yet",
  remove: "Remove",
  save: "Save",
  saveOrder: "Save order",
  saveRole: "Save role",
  revoke: "Revoke",
  check: "Check again",
  moveEarlier: "Move earlier",
  moveLater: "Move later",
  fields: { name: "Name", vendor: "Vendor", budget: "Budget", expiry: "Expiry", isolation: "Isolation" },
  isolation: { none: "None", rules: "Rules", os: "Operating system" },
  runsFirst: "Runs first",
  chain: "Chain",
  windows: { fiveHour: "5-hour window", sevenDay: "7-day window" },
  budget: { steady: "Within budget", half: "Half the budget used", high: "Near the budget", full: "At the budget" },
  spend: { estimate: "Estimate", provider: "Provider", manual: "Manual", balance: "Balance" },
  // The machine runs these. Claude Code: `claude auth login` (https://code.claude.com/docs/en/authentication, read 2026-10-10).
  // Codex: `codex login` (https://developers.openai.com/codex/auth/, read 2026-10-10).
  // Cursor: `agent login` (https://cursor.com/docs/cli/reference/authentication, read 2026-10-10).
  signIn: { claude: "claude auth login", codex: "codex login", cursor: "agent login" },
  addLine: "morndo-keys add",
  runtimes: { claude: "Claude Code", codex: "Codex", cursor: "Cursor agent" },
} as const;

const repo = z.strictObject({ allow: z.array(text(200)), deny: z.array(text(200)) });
const budget = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("capped"), amount: z.number().check(z.gt(0)) }),
  z.strictObject({ kind: z.literal("unlimited") }),
]);

export const ConnectionView = z.strictObject({
  name: name(),
  kind: z.enum(["subscription", "api-key"]),
  custody: z.enum(["morndo", "engine-layer"]),
  vendor: text(64),
  runtime: text(64),
  status: z.enum(["on", "off", "revoked"]),
  termsRevision: z.nullable(text(64)),
  repo: z.nullable(repo),
  isolation: z.enum(["none", "rules", "os"]),
  configDir: z.nullable(text(400)),
  ref: z.nullable(text(80)),
  fingerprint: z.nullable(z.string().check(z.regex(/^[0-9a-f]{12}$/))),
  billing: z.nullable(z.enum(["metered", "prepaid"])),
  budget: z.nullable(budget),
  expiry: z.nullable(z.number()),
});

export const LeaseView = z.strictObject({
  id: text(32),
  connection: name(),
  role: text(64),
  entry: text(200),
  runtime: text(64),
  workspace: text(400),
  isolation: z.enum(["none", "rules", "os"]),
  start: z.number(),
  reservation: z.number(),
  probe: z.boolean(),
  authority: z.enum(["live", "ended"]),
});

export const PolicyView = z.strictObject({
  mode: z.enum(["subscriptions-first", "keys-first", "subscriptions-only", "keys-only", "custom"]),
  order: z.array(name()),
  roles: z.array(z.strictObject({
    role: text(64),
    override: z.enum(["follow", "own", "hand"]),
    mode: z.nullable(z.enum(["subscriptions-first", "keys-first", "subscriptions-only", "keys-only", "custom"])),
    order: z.array(name()),
    picks: z.array(text(200)),
    riskPicks: z.nullable(z.array(text(200))),
    drifted: z.boolean(),
  })),
});

const runtime = z.strictObject({
  runtime: text(64),
  dialect: text(64),
  baseUrl: z.nullable(z.url()),
});
const models = z.discriminatedUnion("source", [
  z.strictObject({ source: z.literal("endpoint"), url: z.url(), shape: z.enum(["openai-list", "anthropic-list"]) }),
  z.strictObject({ source: z.literal("engine-layer") }),
  z.strictObject({ source: z.literal("static"), ids: z.array(text(80)) }),
  z.strictObject({ source: z.literal("ask") }),
]);

export const VendorPreset = z.strictObject({
  id: name(),
  label: text(80),
  custody: z.enum(["morndo", "engine-layer"]),
  kinds: z.array(z.enum(["subscription", "api-key"])).check(z.minLength(1)),
  runtimes: z.array(runtime).check(z.minLength(1)),
  models,
  family: text(64),
  keyShapes: z.array(text(40)),
  spend: z.array(z.enum(["balance", "token-price", "manual", "provider"])),
  prices: z.array(z.strictObject({ at: text(32), model: text(80), input: z.number(), output: z.number() })),
  balance: z.nullable(z.strictObject({ endpoint: z.url(), field: text(120) })),
  defaultPicks: z.record(z.string().check(z.maxLength(64)), text(200)),
  idPatterns: z.optional(z.record(z.string().check(z.maxLength(80)), text(200))),
  isolation: z.nullable(z.enum(["none", "rules", "os"])),
  terms: z.strictObject({
    revision: text(64),
    summary: text(400),
    sources: z.array(z.url()),
  }).check(z.refine((t: { revision: string; sources: readonly string[] }) => (t.revision === "unknown") === (t.sources.length === 0))),
});
export const VendorCatalog = z.array(VendorPreset).check(z.minLength(1));

const mode = z.enum(["subscriptions-first", "keys-first", "subscriptions-only", "keys-only", "custom"]);
const budgetLevel = z.enum(["steady", "half", "high", "full"]);
const spendSource = z.enum(["estimate", "provider", "manual", "balance"]);

// The settings page. No ref, fingerprint or secret: a saved key is never on this message.
export const ConnectionRow = z.strictObject({
  name: name(),
  kind: z.enum(["subscription", "api-key"]),
  vendor: text(64),
  runtime: text(64),
  availability: z.enum(["ready", "off", "revoked", "terms", "expired", "budget", "unarmed"]),
  budgetPercent: z.nullable(z.int().check(z.gte(0), z.lte(100))),
  budgetLevel: z.nullable(budgetLevel),
  expiry: z.nullable(z.number()),
  spendSource: z.nullable(spendSource),
  usageFiveHour: z.nullable(z.number()),
  usageSevenDay: z.nullable(z.number()),
});
export const RoleRow = z.strictObject({
  role: text(64),
  override: z.enum(["follow", "own", "hand"]),
  order: z.array(name()),
  picks: z.array(text(200)),
  riskPicks: z.array(text(200)),
  chain: z.array(text(200)),
  drifted: z.boolean(),
  first: z.nullable(text(200)),
});
export const AlertRow = z.strictObject({
  kind: z.literal("connection"),
  name: text(64),
  detail: text(200),
});
export const CatalogChoice = z.strictObject({
  id: name(),
  label: text(80),
  kinds: z.array(z.enum(["subscription", "api-key"])).check(z.minLength(1)),
  runtimes: z.array(text(64)).check(z.minLength(1)),
  termsSummary: text(400),
  termsSources: z.array(z.url()),
  isolation: z.nullable(z.enum(["none", "rules", "os"])),
});
export const ConnectionsPage = z.strictObject({
  version: z.int(),
  connections: z.array(ConnectionRow),
  mode,
  order: z.array(name()),
  roles: z.array(RoleRow),
  alerts: z.array(AlertRow),
  catalog: z.array(CatalogChoice),
});

export const PriorityCommand = z.strictObject({ version: z.int(), mode, order: z.array(name()) });
export const RoleCommand = z.strictObject({
  version: z.int(),
  role: text(64),
  override: z.enum(["follow", "own", "hand"]),
  order: z.array(name()),
  picks: z.array(text(200)),
  riskPicks: z.exactOptional(z.array(text(200))),
  action: z.enum(["save", "reapply", "keep-hand"]),
});
export const RevokeCommand = z.strictObject({ version: z.int(), name: name() });
export const NarrowCommand = z.strictObject({
  version: z.int(),
  name: name(),
  action: z.enum(["off", "lower-budget", "deny"]),
  budget: z.exactOptional(z.number().check(z.gt(0))),
  deny: z.exactOptional(text(200)),
});

export const COMMAND_KINDS = ["priority", "role", "revoke", "narrow"] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];
// Widening (priority, a role save, revoke) needs a fresh passkey. Narrowing does not.
export const commandNeedsStepUp = (kind: CommandKind): boolean => kind !== "narrow";

export type ConnectionView = z.output<typeof ConnectionView>;
export type LeaseView = z.output<typeof LeaseView>;
export type PolicyView = z.output<typeof PolicyView>;
export type VendorPreset = z.output<typeof VendorPreset>;
export type ConnectionsPage = z.output<typeof ConnectionsPage>;
export type PriorityCommand = z.output<typeof PriorityCommand>;
export type RoleCommand = z.output<typeof RoleCommand>;
export type RevokeCommand = z.output<typeof RevokeCommand>;
export type NarrowCommand = z.output<typeof NarrowCommand>;

export function parseVendorCatalog(value: unknown): VendorPreset[] | null {
  const parsed = z.safeParse(VendorCatalog, value);
  return parsed.success ? parsed.data : null;
}
