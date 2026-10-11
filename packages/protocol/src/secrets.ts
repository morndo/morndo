// Secrets on the wire (ADR-0022; design §14). References and metadata only. The one place bytes travel is SealedValue:
// an age file sealed to one node's recipient, on the Endpoint or on a source node. Every schema is strict, so a key it
// doesn't name is refused whole. The words table is the one the CLI and the page share; the token shape catalog is data
// (catalog/secret-shapes.json), each shape with its source.
import {
  DESTINATIONS_MAX, DESTINATION_HOST, KEYED_FINGERPRINT, LANE_NAME, NODE_LABEL, PURPOSE_MAX, REQUEST_KINDS, REQUEST_STATES, SECRET_STATUSES,
  SHAPE_ID, STORED_KINDS, USE_MODES, USE_REFUSAL_REASONS, WORKSPACE_NAME, eachOnce, parseReference, plainText,
} from "@morndo/domain";
import { ED25519_SIGNATURE } from "./fleet.ts";
import * as z from "./z.ts";

// The rules are the domain's (and the fleet's signature), imported, so the wire refuses exactly what the domain does.
// The length checks come first so a refusal names its limit; the domain's rule decides the rest. A list checks its length
// and its items on their own and refines only with the domain's each-once rule, so no refusal names a rule that held.
const plain = (max: number) => z.string().check(z.minLength(1), z.maxLength(max), z.refine(s => plainText(s, max), "plain text"));
const id = () => z.string().check(z.regex(/^[A-Za-z0-9_-]{1,64}$/));   // a request or attempt id: the wire's own
const node = () => z.string().check(z.regex(NODE_LABEL));
const lane = () => z.string().check(z.regex(LANE_NAME));
const workspace = () => z.string().check(z.regex(WORKSPACE_NAME));
const host = () => z.string().check(z.regex(DESTINATION_HOST));
const shapeId = () => z.string().check(z.regex(SHAPE_ID));
const when = () => z.number().check(z.refine(Number.isFinite, "a time"));
const version = () => z.number().check(z.int(), z.gte(1));
const mode = () => z.enum(USE_MODES);
const signature = () => z.string().check(z.regex(ED25519_SIGNATURE));

export const SecretReferenceText = z.string().check(z.maxLength(120), z.refine(s => parseReference(s) !== null, "a secret:// Reference"));

// An age X25519 recipient: "age1" and the Bech32 data and checksum of 32 bytes, 58 characters of its alphabet
// (https://github.com/C2SP/C2SP/blob/main/age.md, read 2026-10-11). The age library checks the checksum.
export const AgeRecipient = z.string().check(z.regex(/^age1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/));

// Base64 of an age v1 file: its header starts "age-encryption.org/v1\n", whose base64 starts with these 29 characters.
export const SEALED_MAX_BYTES = 64 * 1024;
const AGE_V1_BASE64 = "YWdlLWVuY3J5cHRpb24ub3JnL3YxC";
const decodedLength = (s: string) => (s.length / 4) * 3 - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0);
export const SealedValue = z.string().check(
  z.regex(/^[A-Za-z0-9+/]*={0,2}$/),
  z.refine(s => s.length % 4 === 0 && s.startsWith(AGE_V1_BASE64) && decodedLength(s) <= SEALED_MAX_BYTES, "an age v1 file of at most 64 KiB"),
);

export const WireGrantSubject = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("lane"), lane: lane() }),
  z.strictObject({ kind: z.literal("workspace"), workspace: workspace() }),
  z.strictObject({ kind: z.literal("node") }),
]);
export const WireGrant = z.strictObject({
  subject: WireGrantSubject,
  modes: z.array(mode()).check(z.minLength(1), z.maxLength(USE_MODES.length), z.refine(eachOnce, "each mode once")),
  until: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("open") }),
    z.strictObject({ kind: z.literal("at"), at: when() }),
    z.strictObject({ kind: z.literal("lane-end") }),
  ]),
});
const destinations = () => z.array(host()).check(z.maxLength(DESTINATIONS_MAX), z.refine(eachOnce, "each host once"));

// Node to hub: a request, as the node saw it (design §4.1). The hub takes it in through NodeRequests.
export const SecretRequestedEvent = z.strictObject({
  node: node(), reference: SecretReferenceText, kind: z.enum(REQUEST_KINDS), lane: z.nullable(lane()),
  workspace: z.nullable(workspace()), purpose: plain(PURPOSE_MAX), proposed: WireGrant,
});

// Hub to node: how a request ended, for `wait`, `status` and the lane notice.
export const SecretAnsweredArgs = z.strictObject({
  request: id(), reference: SecretReferenceText, outcome: z.enum(["stored", "granted", "rejected", "withdrawn", "expired"]),
  reason: z.nullable(plain(300)),
});

export const SecretRequestView = z.strictObject({
  id: id(), node: node(), reference: SecretReferenceText, kind: z.enum(REQUEST_KINDS), state: z.enum(REQUEST_STATES),
  version: version(), openedAt: when(),
  waiting: z.array(z.strictObject({ lane: z.nullable(lane()), workspace: z.nullable(workspace()), purpose: plain(300), at: when() })),
  proposed: WireGrant,
});

export const SecretView = z.strictObject({
  node: node(), reference: SecretReferenceText, status: z.enum(SECRET_STATUSES), version: z.nullable(version()),
  keyedFingerprint: z.nullable(z.string().check(z.regex(KEYED_FINGERPRINT))), grants: z.array(WireGrant),
  destinations: destinations(), expiry: z.nullable(when()), shape: z.nullable(shapeId()), lastUse: z.nullable(when()),
});

// The card's Store (design §5.3): one SealedValue per target node, each sealed to the recipient this Endpoint pinned.
export const StoreSecretBody = z.strictObject({
  requestId: id(), seen: version(), reference: SecretReferenceText, grant: WireGrant, expiry: z.nullable(when()),
  destinations: destinations(),
  targets: z.array(z.strictObject({ node: node(), recipient: AgeRecipient, sealed: SealedValue })).check(z.minLength(1), z.maxLength(8)),
});

// The fleet operations (design §14). Registered with the fleet's operation list when the hub and node use them (PR 4).
// A store names the request it answers and its kind (none from the Secrets page or the machine), so the node can hold a
// renew to its rule before it stores anything (design §5.3, step 6; decided on T-80).
export const SecretsStoreArgs = z.strictObject({
  reference: SecretReferenceText, sealed: SealedValue, grants: z.array(WireGrant), expiry: z.nullable(when()),
  destinations: destinations(), request: z.nullable(z.strictObject({ id: id(), kind: z.enum(STORED_KINDS) })),
});
export const SecretsTransferArgs = z.strictObject({ reference: SecretReferenceText, target: node(), recipient: AgeRecipient, signature: signature() });
export const SecretsTransferResult = z.strictObject({ sealed: SealedValue });
export const SecretsCheckArgs = z.strictObject({ reference: SecretReferenceText, lane: z.nullable(lane()), workspace: z.nullable(workspace()), mode: mode() });
export const SecretsCheckResult = z.strictObject({
  admitted: z.boolean(),
  reason: z.nullable(z.enum(USE_REFUSAL_REASONS)),
});
export const SecretsGrantArgs = z.strictObject({ reference: SecretReferenceText, grant: WireGrant });
export const SecretsUngrantArgs = z.strictObject({ reference: SecretReferenceText, subject: WireGrantSubject });
export const SecretsLifecycleArgs = z.strictObject({ reference: SecretReferenceText, action: z.enum(["disable", "enable", "revoke", "delete"]) });
export const SecretsRecipientResult = z.strictObject({ recipient: AgeRecipient, signature: signature() });
export const SecretsListResult = z.strictObject({ held: z.array(SecretView) });

// Every secrets schema, by name: what the wire test walks.
export const SECRET_WIRE = {
  SecretRequestedEvent, SecretAnsweredArgs, SecretRequestView, SecretView, StoreSecretBody, SecretsStoreArgs,
  SecretsTransferArgs, SecretsTransferResult, SecretsCheckArgs, SecretsCheckResult, SecretsGrantArgs, SecretsUngrantArgs,
  SecretsLifecycleArgs, SecretsRecipientResult, SecretsListResult,
} as const;

// ---- The token shape catalog (design §8.2): public prefixes only, each from its vendor's page.

const compiles = (p: string) => {
  try { new RegExp(p); return true; } catch { return false; }
};
export const SecretShape = z.strictObject({
  id: shapeId(),
  label: plain(80),
  vendor: plain(40),
  prefix: z.string().check(z.regex(/^[A-Za-z0-9_-]{2,20}$/)),
  pattern: z.string().check(z.maxLength(200), z.refine(compiles, "a regular expression")),
  source: z.strictObject({
    url: z.string().check(z.regex(/^https:\/\/[!-~]+$/)),
    checked: z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/)),
    quote: plain(300),
  }),
});
export const SecretShapeCatalog = z.array(SecretShape).check(z.minLength(1));
export type SecretShape = z.output<typeof SecretShape>;
export function parseSecretShapeCatalog(value: unknown): SecretShape[] | null {
  const parsed = z.safeParse(SecretShapeCatalog, value);
  return parsed.success ? parsed.data : null;
}

// ---- Words (one table for the CLI and the page)

export const SECRET_WORDS = {
  title: "Secrets",
  card: {
    title: "Insert secret", whoAsks: "Asked by", sawIt: "as the machine saw it", agentSays: "The agent says",
    field: "Value", show: "Show", hide: "Hide", multiline: "Several lines", fromFile: "From a file",
    tooShort: "Too short to filter from output", wider: "Wider than requested", sameAs: "Same value as",
    expiry: "Expires", destinations: "Only for these hosts", nodes: "Store on",
    recipientChanged: "This machine's key changed. Compare it on the machine before storing.",
  },
  buttons: { store: "Store", grant: "Grant", reject: "Reject", later: "Later" },
  kinds: { new: "New secret", access: "Access to an existing secret", rotate: "Replace the value", renew: "Renew: the value expired" },
  states: { open: "Waiting", stored: "Stored", granted: "Granted", rejected: "Rejected", withdrawn: "Withdrawn", expired: "Expired" },
  status: { active: "Active", disabled: "Disabled", revoked: "Revoked" },
  modes: { exec: "In the environment", file: "In a file", helper: "Credential helper", inject: "Sent by the sandbox" },
  // Design §7.0: what each mode keeps from the agent.
  protects: {
    exec: "Programs this agent starts can read it.",
    file: "Programs this agent starts can read it.",
    helper: "Programs this agent starts can read it.",
    inject: "The agent's commands never hold it.",
  },
  subjects: { lane: "This lane only", workspace: "This repository, any lane", node: "Every lane on this machine" },
  ends: { open: "Until revoked", at: "Until a date", "lane-end": "Until the lane ends" },
  refusals: {
    missing: "No such secret on this machine", disabled: "Disabled", revoked: "Revoked", no_value: "No value on this machine",
    expired: "Expired", not_granted: "Not granted to this lane", mode: "Not allowed this way",
  },
  actions: { replace: "Replace the value", disable: "Disable", enable: "Enable", revoke: "Revoke", delete: "Delete", transfer: "Copy to another machine" },
} as const;

// The agents' instructions (design §4.3). docs/agents/secrets.md carries the same text; a test keeps them equal.
export const SECRETS_PROMPT = `## Secrets

You never see secret values, and you never ask for one in chat. You use them by name: a Reference such as
\`secret://example-app/payments-test\`, which is safe to show and to commit.

- To get a secret you don't have: \`morndo-secrets request <reference> --purpose "<why, in one line>"\`. Add \`--wait\`
  to wait for the answer, or carry on; you get a notice when it is answered. Never ask for a secret in chat, in a
  report, or in a question.
- To use one, start the program through Morndo: \`morndo-secrets run --file NAME=<reference> -- <command>\` when the
  tool can read the value from a file, and \`--env NAME=<reference>\` only when it can't.
- Never write a value into a file, an argument, a commit or your output.
- A config that needs a secret gets a Reference line, such as \`PAYMENTS_KEY=secret://example-app/payments-test\` in
  an env file you pass with \`--env-file\`.
- \`morndo-secrets list\` shows what this lane may use here. A refusal names the request to make.
- If you ever see a value in any output, run \`morndo-secrets disable <reference>\` at once and say so in your report.
`;
