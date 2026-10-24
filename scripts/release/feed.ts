// Channel feeds (design §9.5, §9.6). Publishing adds a release and raises the number. A re-sign
// raises the number, sets the issue time, and sets the expiry 14 days later. The release list,
// the withdrawals, the channel and the key-set version stay as they were. A withdrawal appends
// the version and raises the number; the release list stays. A promotion copies one release
// from latest onto stable and raises the number; the release is not rebuilt.
import { compareVersions, parseVersion, type Channel, type FeedEntry } from "@morndo/domain";
import { ChannelFeedSchema } from "@morndo/protocol";
import { canonicalJson, isoUtc } from "./json.ts";

export const FEED_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const PROMOTION_WAIT_MS = 7 * 24 * 60 * 60 * 1000;

export function emptyFeed(p: { channel: Channel; now: number; keySetVersion: number }): string {
  return writeFeed({ channel: p.channel, seq: 1, issuedAt: p.now, keySetVersion: p.keySetVersion, releases: [], withdrawn: [] });
}

export function publishRelease(existing: string | null, p: {
  channel: Channel; entry: FeedEntry; now: number; keySetVersion: number;
}): string {
  if (existing === null) {
    return writeFeed({ channel: p.channel, seq: 1, issuedAt: p.now, keySetVersion: p.keySetVersion, releases: [p.entry], withdrawn: [] });
  }
  const prev = ChannelFeedSchema.parse(JSON.parse(existing));
  if (prev.channel !== p.channel) throw new Error(`feed is ${prev.channel}, not ${p.channel}`);
  if (prev.keySetVersion !== p.keySetVersion) throw new Error("feed names a different key set");
  if (prev.releases.some(r => r.version === p.entry.version)) throw new Error(`feed already lists ${p.entry.version}`);
  const releases = [...prev.releases, p.entry].sort((a, b) => compareVersions(mustVersion(b.version), mustVersion(a.version)));
  return writeFeed({
    channel: prev.channel, seq: prev.seq + 1, issuedAt: p.now, keySetVersion: prev.keySetVersion,
    releases, withdrawn: [...prev.withdrawn],
  });
}

export function resignFeed(existing: string, now: number): string {
  const prev = ChannelFeedSchema.parse(JSON.parse(existing));
  return writeFeed({
    channel: prev.channel, seq: prev.seq + 1, issuedAt: now, keySetVersion: prev.keySetVersion,
    releases: prev.releases, withdrawn: [...prev.withdrawn],
  });
}

export function promoteRelease(existingStable: string, latest: string, version: string, now: number): string {
  const stable = ChannelFeedSchema.parse(JSON.parse(existingStable));
  const from = ChannelFeedSchema.parse(JSON.parse(latest));
  if (stable.channel !== "stable") throw new Error(`feed is ${stable.channel}, not stable`);
  if (from.channel !== "latest") throw new Error(`feed is ${from.channel}, not latest`);
  const entry = from.releases.find(release => release.version === version);
  if (entry === undefined) throw new Error(`${version} is not in the latest feed`);
  if (stable.releases.some(release => release.version === version)) throw new Error(`${version} is already in the stable feed`);
  if (from.withdrawn.includes(version) || stable.withdrawn.includes(version)) throw new Error(`${version} is withdrawn`);
  const releases = [...stable.releases, entry].sort((a, b) => compareVersions(mustVersion(b.version), mustVersion(a.version)));
  return writeFeed({
    channel: stable.channel, seq: stable.seq + 1, issuedAt: now, keySetVersion: stable.keySetVersion,
    releases, withdrawn: [...stable.withdrawn],
  });
}

export function withdrawRelease(existing: string, version: string, now: number): string {
  const prev = ChannelFeedSchema.parse(JSON.parse(existing));
  const listed = prev.releases.find(release => release.version === version);
  const text = listed === undefined ? version : listed.version;
  if (prev.withdrawn.includes(text)) throw new Error(`${version} is already withdrawn in the ${prev.channel} feed`);
  return writeFeed({
    channel: prev.channel, seq: prev.seq + 1, issuedAt: now, keySetVersion: prev.keySetVersion,
    releases: prev.releases, withdrawn: [...prev.withdrawn, text],
  });
}

function mustVersion(text: string) {
  const version = parseVersion(text);
  if (!version) throw new Error(`not a version: ${text}`);
  return version;
}

function writeFeed(p: {
  channel: Channel; seq: number; issuedAt: number; keySetVersion: number; releases: FeedEntry[]; withdrawn: string[];
}): string {
  const doc = {
    schema: 1,
    channel: p.channel,
    seq: p.seq,
    issuedAt: isoUtc(p.issuedAt),
    expiresAt: isoUtc(p.issuedAt + FEED_TTL_MS),
    keySetVersion: p.keySetVersion,
    releases: p.releases.map(entry => ({
      version: entry.version, manifest: entry.manifest, manifestSize: entry.manifestSize, manifestSha256: entry.manifestSha256,
    })),
    withdrawn: p.withdrawn,
  };
  const parsed = ChannelFeedSchema.safeParse(doc);
  if (!parsed.success) throw new Error("feed is not the wire's shape");
  return canonicalJson(doc);
}
