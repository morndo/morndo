// The releases on the wire (ADR-0019; docs/design/updates/README.md §9.6): the three signed documents (keys.json,
// manifest.json, the ChannelFeed), the file list inside an installed Version, and the health and safe-point shapes the
// probes read. The decoded shapes are the domain's own, checked at compile time below; timestamps are UTC instants
// (RFC 3339, no offset: the documents are signed as written) and decode to ms since the epoch, which is all the domain
// ever sees. Untrusted bytes go through these and nothing else: an unknown field, a local time or a wrong type is a
// refusal, never a guess. The signatures beside the documents are the updater's to verify before any of this is read.
import type {
  ArtifactRef, CHANNELS, Channel, ChannelFeed, FeedEntry, HealthReport, KeySet, Manifest, PLATFORMS, ProtocolRange,
  SafePointReport, SchemaInfo,
} from "@morndo/domain";
import * as z from "./z.ts";

// The domain's own words, re-declared so the package stays free of runtime imports it doesn't need (board.ts's pattern).
const CHANNEL_WORDS = ["stable", "latest"] as const satisfies typeof CHANNELS;
const PLATFORM_WORDS = ["linux-x64", "linux-arm64", "darwin-arm64"] as const satisfies typeof PLATFORMS;

// A Version is SemVer 2.0.0, spelled exactly as the spec's official regex (https://semver.org/#is-there-a-suggested-
// regular-expression-regex-to-check-a-semver-string, read 2026-10-11). The domain parses it again its own way; here it
// only has to be a well-formed Version, or nothing.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const version = () => z.string().check(z.regex(SEMVER));
const sha256 = () => z.string().check(z.regex(/^[0-9a-f]{64}$/));
const commit = () => z.string().check(z.regex(/^[0-9a-f]{40}$/));
// A key is named by its fingerprint; the format is the trust layer's choice, so the wire takes any bounded word.
const fingerprint = z.string().check(z.minLength(1), z.maxLength(128));
const httpsUrl = () => z.string().check(z.regex(/^https:\/\/[!-~]+$/), z.maxLength(2000));
// A UTC instant, written with a Z and no offset, decoded to ms since the epoch.
const epoch = () => z.pipe(z.string().check(z.iso.datetime()), z.transform(s => Date.parse(s)));

// ---- keys.json (root's document)

export const KeySetSchema = z.strictObject({
  schema: z.literal(1),
  version: z.int().check(z.gte(1)),
  expiresAt: epoch(),
  root: z.array(fingerprint),
  release: z.array(fingerprint),
  feed: z.array(fingerprint),
});

// ---- stable.json / latest.json (the feed key's document)

export const FeedEntrySchema = z.strictObject({
  version: version(),
  manifest: httpsUrl(),
  manifestSize: z.int().check(z.gte(1)),
  manifestSha256: sha256(),
});
export const ChannelFeedSchema = z.strictObject({
  schema: z.literal(1),
  channel: z.enum(CHANNEL_WORDS),
  seq: z.int().check(z.gte(1)),
  issuedAt: epoch(),
  expiresAt: epoch(),
  keySetVersion: z.int().check(z.gte(1)),
  releases: z.array(FeedEntrySchema),
  withdrawn: z.array(version()),
});

// ---- manifest.json (the release key's document, one per Release)

const SchemaInfoSchema = z.strictObject({ version: z.int().check(z.gte(1)), floor: z.int().check(z.gte(1)) });
const SchemasSchema = z.strictObject({           // one entry per database, all four of them
  hub: SchemaInfoSchema, fleet: SchemaInfoSchema, node: SchemaInfoSchema, connections: SchemaInfoSchema,
});
const boundedInt = z.int().check(z.gte(1));
export const ProtocolRangeSchema = z.strictObject({
  agent: z.tuple([boundedInt, boundedInt]),
  clientApi: z.tuple([boundedInt, boundedInt]),
});
export const ArtifactRefSchema = z.strictObject({
  platform: z.enum(PLATFORM_WORDS),
  name: z.string().check(z.regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,200}$/)),
  size: z.int().check(z.gte(1)),
  sha256: sha256(),
  filesSha256: sha256(),
  node: version(),                                // the bundled runtime's own Version
});
export const ManifestSchema = z.strictObject({
  schema: z.literal(1),
  product: z.literal("morndo"),
  version: version(),
  commit: commit(),
  publishedAt: epoch(),
  notes: httpsUrl(),
  protocol: ProtocolRangeSchema,
  schemas: SchemasSchema,
  artifacts: z.array(ArtifactRefSchema).check(z.minLength(1)),
});

// ---- files.json (inside an installed Version; its digest is the Manifest's filesSha256)

// A path inside the tree: relative, a list of plain segments — none empty, `.`, `..`, or holding a NUL or line break
// (a NUL truncates at the file system and can alias two entries to one file in the file_list check). A mode as ls
// writes it, octal, four digits.
const treePath = z.string().check(
  z.regex(/^(?!\.(?:\/|$))(?!\.\.(?:\/|$))[^/\u0000\n\r\u2028\u2029]+(?:\/(?!\.(?:\/|$))(?!\.\.(?:\/|$))[^/\u0000\n\r\u2028\u2029]+)*$/),
  z.maxLength(512));
const fileMode = z.string().check(z.regex(/^0[0-7]{3}$/));
export const FileEntrySchema = z.strictObject({ path: treePath, mode: fileMode, sha256: sha256() });
export const FileListSchema = z.array(FileEntrySchema);

// ---- health and safe-point shapes (§6.3, §6.4): what the probes read

// The hub's `GET /api/health`: a request through the network proxy, without a session, gets `ready` only.
export const HubHealthSchema = z.strictObject({
  version: z.exactOptional(version()),
  schema: z.exactOptional(z.int().check(z.gte(1))),
  ready: z.boolean(),
});
// The fleet's `GET /v1/health` on its socket.
export const FleetHealthSchema = z.strictObject({ version: version(), schema: z.int().check(z.gte(1)) });
// The agent's `status.json`: its Version, whether it is ready, and the fleet's state as it sees it.
export const NodeStatusSchema = z.strictObject({ version: version(), ready: z.boolean(), fleet: z.string() });
// What a service answers when asked for its safe point, and its health at one Version — the domain judges both.
export const SafePointReportSchema = z.strictObject({
  service: z.string().check(z.minLength(1), z.maxLength(100)),
  blockers: z.array(z.string().check(z.maxLength(500))),
});
export const HealthReportSchema = z.strictObject({
  service: z.string().check(z.minLength(1), z.maxLength(100)),
  version: z.string().check(z.minLength(1), z.maxLength(64)),
  checks: z.record(z.string(), z.boolean()),
});

// The decoded shapes are the domain's own (checked at compile time).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const check = <T extends true>(t: T) => t;
check<Same<z.output<typeof KeySetSchema>, KeySet>>(true);
check<Same<z.output<typeof FeedEntrySchema>, FeedEntry>>(true);
check<Same<z.output<typeof ChannelFeedSchema>, ChannelFeed>>(true);
check<Same<z.output<typeof SchemaInfoSchema>, SchemaInfo>>(true);
check<Same<z.output<typeof ProtocolRangeSchema>, ProtocolRange>>(true);
check<Same<z.output<typeof ArtifactRefSchema>, ArtifactRef>>(true);
check<Same<z.output<typeof ManifestSchema>, Manifest>>(true);
check<Same<z.output<typeof SafePointReportSchema>, SafePointReport>>(true);
check<Same<z.output<typeof HealthReportSchema>, HealthReport>>(true);
// The channel word is the domain's Channel (a literal union, not a widened string).
check<Same<z.output<typeof ChannelFeedSchema>["channel"], Channel>>(true);
