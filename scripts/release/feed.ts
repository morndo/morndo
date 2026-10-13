// Channel feeds (design §9.5, §9.6). Publishing adds a release and raises the number. A re-sign
// raises the number, sets the issue time, and sets the expiry 14 days later. The release list,
// the withdrawals, the channel and the key-set version stay as they were.
import { compareVersions, parseVersion, type Channel, type FeedEntry } from "@morndo/domain";
import { ChannelFeedSchema } from "@morndo/protocol";
import { canonicalJson, isoUtc } from "./json.ts";

export const FEED_TTL_MS = 14 * 24 * 60 * 60 * 1000;

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
