// The wire schemas against the design's own example documents (§9.6: "All values above are made up for the example").
// Each parses to the domain's shape; everything else — an unknown field, a local time, a wrong type, a bad digest — is
// a refusal, because these documents come from the network and are trusted only after they verify.
import { describe, expect, it } from "vitest";
import type { ChannelFeed, KeySet, Manifest } from "@morndo/domain";
import {
  ChannelFeedSchema, FeedEntrySchema, FileListSchema, FleetHealthSchema, HealthReportSchema, HubHealthSchema,
  KeySetSchema, ManifestSchema, NodeStatusSchema, SafePointReportSchema,
} from "../src/releases.ts";

const parse = <S extends { safeParse: (d: unknown) => { success: boolean } }>(schema: S, doc: unknown) =>
  schema.safeParse(doc).success;

describe("keys.json (root's document)", () => {
  const doc = { schema: 1, version: 1, expiresAt: "2027-11-02T10:00:00Z",
    root: ["SHA256:root-fingerprint-1"], release: ["SHA256:release-fingerprint-1"], feed: ["SHA256:feed-fingerprint-1"] };
  it("parses to the domain's KeySet, the instant as ms since the epoch", () => {
    const r = KeySetSchema.safeParse(doc);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ schema: 1, version: 1, expiresAt: Date.parse("2027-11-02T10:00:00Z"),
      root: ["SHA256:root-fingerprint-1"], release: ["SHA256:release-fingerprint-1"], feed: ["SHA256:feed-fingerprint-1"] } satisfies KeySet);
  });
  it("negative control: a timestamp with an offset is refused — the documents are signed as written", () => {
    expect(parse(KeySetSchema, { ...doc, expiresAt: "2027-11-02T10:00:00-05:00" })).toBe(false);
  });
  it("negative control: an unknown field is refused", () => {
    expect(parse(KeySetSchema, { ...doc, extra: true })).toBe(false);
  });
});

describe("stable.json / latest.json (the feed key's document)", () => {
  const doc = { schema: 1, channel: "stable", seq: 42,
    issuedAt: "2026-11-02T10:05:00Z", expiresAt: "2026-11-16T10:05:00Z", keySetVersion: 1,
    releases: [{ version: "0.5.0", manifest: "https://github.com/morndo/morndo/releases/download/v0.5.0/manifest.json",
      manifestSize: 2048, manifestSha256: "ab".repeat(32) }],
    withdrawn: ["0.4.1"] };
  it("parses to the domain's ChannelFeed", () => {
    const r = ChannelFeedSchema.safeParse(doc);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.seq).toBe(42);
      expect(r.data.issuedAt).toBe(Date.parse("2026-11-02T10:05:00Z"));
      expect(r.data.expiresAt).toBe(Date.parse("2026-11-16T10:05:00Z"));
      const feed: ChannelFeed = r.data;                    // the compile-time Same<> check, once at runtime too
      expect(feed.channel).toBe("stable");
    }
  });
  it("negative control: a seq that is not a number is refused", () => {
    expect(parse(ChannelFeedSchema, { ...doc, seq: "42" })).toBe(false);
  });
  it("negative control: a channel the domain doesn't know is refused", () => {
    expect(parse(ChannelFeedSchema, { ...doc, channel: "beta" })).toBe(false);
  });
  it("negative control: an entry's digest that isn't 64 lowercase hex is refused", () => {
    expect(parse(ChannelFeedSchema, { ...doc, releases: [{ ...doc.releases[0]!, manifestSha256: "AB".repeat(32) }] })).toBe(false);
    expect(parse(ChannelFeedSchema, { ...doc, releases: [{ ...doc.releases[0]!, manifestSha256: "ab".repeat(31) }] })).toBe(false);
  });
  it("negative control: a Version that isn't SemVer is refused, withdrawn ones included", () => {
    expect(parse(ChannelFeedSchema, { ...doc, releases: [{ ...doc.releases[0]!, version: "v0.5.0" }] })).toBe(false);
    expect(parse(ChannelFeedSchema, { ...doc, withdrawn: ["0.5"] })).toBe(false);
    expect(parse(FeedEntrySchema, { ...doc.releases[0]!, manifest: "http://plain.example/manifest.json" })).toBe(false);
  });
});

describe("manifest.json (the release key's document)", () => {
  const doc = { schema: 1, product: "morndo", version: "0.5.0", commit: "1f".repeat(20),
    publishedAt: "2026-11-02T10:00:00Z", notes: "https://github.com/morndo/morndo/releases/tag/v0.5.0",
    protocol: { agent: [1, 2], clientApi: [1, 1] },
    schemas: { hub: { version: 19, floor: 17 }, fleet: { version: 15, floor: 15 },
      node: { version: 6, floor: 3 }, connections: { version: 1, floor: 1 } },
    artifacts: [{ platform: "linux-x64", name: "morndo-0.5.0-linux-x64.tar.gz", size: 48_210_944,
      sha256: "cd".repeat(32), filesSha256: "ef".repeat(32), node: "24.21.0" }] };
  it("parses to the domain's Manifest, all four databases present", () => {
    const r = ManifestSchema.safeParse(doc);
    expect(r.success).toBe(true);
    if (r.success) {
      const manifest: Manifest = r.data;
      expect(manifest.schemas.hub).toEqual({ version: 19, floor: 17 });
      expect(manifest.protocol.agent).toEqual([1, 2]);
      expect(manifest.publishedAt).toBe(Date.parse("2026-11-02T10:00:00Z"));
    }
  });
  it("negative control: a database left out is refused", () => {
    const { hub, fleet, node } = doc.schemas;
    expect(parse(ManifestSchema, { ...doc, schemas: { hub, fleet, node } })).toBe(false);
  });
  it("negative control: an unknown platform, or no artifact at all, is refused", () => {
    expect(parse(ManifestSchema, { ...doc, artifacts: [{ ...doc.artifacts[0]!, platform: "linux-68k" }] })).toBe(false);
    expect(parse(ManifestSchema, { ...doc, artifacts: [] })).toBe(false);
  });
  it("negative control: a commit that isn't 40 hex is refused", () => {
    expect(parse(ManifestSchema, { ...doc, commit: "1f".repeat(19) })).toBe(false);
  });
  it("a floor of 0 is a database with no breaking migration, and a negative floor is refused", () => {
    expect(parse(ManifestSchema, { ...doc, schemas: { ...doc.schemas, hub: { version: 17, floor: 0 } } })).toBe(true);
    expect(parse(ManifestSchema, { ...doc, schemas: { ...doc.schemas, hub: { version: 17, floor: -1 } } })).toBe(false);
  });
});

describe("files.json (the file list inside an installed Version)", () => {
  const doc = [{ path: "app/server.js", mode: "0555", sha256: "12".repeat(32) },
    { path: "bin/morndo", mode: "0555", sha256: "34".repeat(32) }];
  it("every file with its mode and SHA-256", () => {
    expect(parse(FileListSchema, doc)).toBe(true);
  });
  it("negative control: a mode without its leading zero, or an absolute path, or a `..` segment, is refused", () => {
    expect(parse(FileListSchema, [{ ...doc[0]!, mode: "644" }])).toBe(false);
    expect(parse(FileListSchema, [{ ...doc[0]!, path: "/etc/passwd" }])).toBe(false);
    expect(parse(FileListSchema, [{ ...doc[0]!, path: "app/../../etc/passwd" }])).toBe(false);
  });
  it("negative control: a NUL byte, a `.` or `..` segment, or an empty segment, is refused", () => {
    // The comment's promise: a relative path of plain segments. A NUL truncates the path at the file system and can
    // alias two entries to one file during the file_list check; `.` and `..` move inside the tree; an empty segment
    // (a `//` or a trailing `/`) is not a name.
    for (const path of ["a\u0000b", "./a", "a//b", ".", "..", "a/.", "a/", "a/b/.."])
      expect(parse(FileListSchema, [{ ...doc[0]!, path }]), path).toBe(false);
  });
  it("a dotfile, and dots inside a name, are still plain segments", () => {
    expect(parse(FileListSchema, [{ ...doc[0]!, path: "app/.env.example" }])).toBe(true);
    expect(parse(FileListSchema, [{ ...doc[0]!, path: "a..b/c" }])).toBe(true);
  });
});

describe("health and safe-point shapes (§6.3, §6.4)", () => {
  it("the hub answers a session with version and schema; a proxied stranger with ready only", () => {
    expect(parse(HubHealthSchema, { version: "0.5.0", schema: 19, ready: true })).toBe(true);
    expect(parse(HubHealthSchema, { ready: true })).toBe(true);
    expect(parse(HubHealthSchema, { ready: "yes" })).toBe(false);
    expect(parse(HubHealthSchema, { version: "0.5", ready: true })).toBe(false);
  });
  it("the fleet and the agent answer on their own", () => {
    expect(parse(FleetHealthSchema, { version: "0.5.0", schema: 15 })).toBe(true);
    expect(parse(FleetHealthSchema, { version: "0.5.0" })).toBe(false);
    expect(parse(NodeStatusSchema, { version: "0.5.0", ready: true, fleet: "ok" })).toBe(true);
  });
  it("a service's safe point and health, in the domain's shapes", () => {
    expect(SafePointReportSchema.safeParse({ service: "hub", blockers: [] }).success).toBe(true);
    expect(SafePointReportSchema.safeParse({ service: "hub", blockers: ["a Decision being typed"] }).success).toBe(true);
    expect(SafePointReportSchema.safeParse({ service: "hub" }).success).toBe(false);
    expect(HealthReportSchema.safeParse({ service: "hub", version: "0.5.0", checks: { "/api/health": true, schema: true } }).success).toBe(true);
    expect(parse(HealthReportSchema, { service: "hub", version: "0.5.0", checks: { "/api/health": "yes" } })).toBe(false);
  });
});
