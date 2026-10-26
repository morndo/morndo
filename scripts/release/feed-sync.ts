// The feed branch is written in three steps so the signing key never meets npm code:
// prepare builds the unsigned feeds, a shell step signs them with ssh-keygen, commit verifies
// the signatures and pushes only if the branch still points at the commit prepare read.
// Update a reference leaves force false, so a moved branch is rejected
// (https://docs.github.com/en/rest/git/refs#update-a-reference, read 2026-10-13).
// A moved branch fails the job; running it again reads the new head.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseVersion } from "@morndo/domain";
import { ChannelFeedSchema } from "@morndo/protocol";
import { emptyFeed, PROMOTION_WAIT_MS, promoteRelease, publishRelease, resignFeed, withdrawRelease } from "./feed.ts";
import { FEED_FILES, gh, must, readAt, readFeedHead, verifyFeed } from "./feed-site.ts";
import { isoUtc } from "./json.ts";

// The trees API writes the blob when the entry carries content, so the feed push
// does not create a blob per file first.
// https://docs.github.com/en/rest/git/trees#create-a-tree (read 2026-10-13)
export function feedTree(files: readonly { path: string; content: string }[]): { path: string; mode: "100644"; type: "blob"; content: string }[] {
  return files.map(file => ({ path: file.path, mode: "100644", type: "blob", content: file.content }));
}

function writeRef(repository: string, parent: string | null, dir: string, message: string): "ok" | "moved" {
  const tree = must(gh(
    ["api", "--method", "POST", `/repos/${repository}/git/trees`, "--jq", ".sha", "--input", "-"],
    JSON.stringify({ tree: feedTree(FEED_FILES.map(file => ({ path: file, content: readFileSync(join(dir, file), "utf8") }))) }),
  ), "tree");
  const commit = must(gh(
    ["api", "--method", "POST", `/repos/${repository}/git/commits`, "--jq", ".sha", "--input", "-"],
    JSON.stringify({ message, tree, parents: parent === null ? [] : [parent] }),
  ), "commit");
  const update = parent === null
    ? gh(["api", "--method", "POST", `/repos/${repository}/git/refs`, "-f", "ref=refs/heads/feed", "-f", `sha=${commit}`])
    : gh(["api", "--method", "PATCH", `/repos/${repository}/git/refs/heads/feed`, "-f", `sha=${commit}`]);
  return refUpdateResult(update.ok, update.stderr);
}

// force defaults to false, so a non-fast-forward update is rejected.
// Creating a ref that is already there is also 422 "Reference already exists".
// https://docs.github.com/en/rest/git/refs#update-a-reference (read 2026-10-13)
// https://docs.github.com/en/rest/git/refs#create-a-reference (read 2026-10-13)
// Retry only for those races. Any other 422 or 409 fails with GitHub's message.
export function refUpdateResult(ok: boolean, stderr: string): "ok" | "moved" {
  if (ok) return "ok";
  if (/not a fast forward/i.test(stderr) || /reference moved/i.test(stderr) || /reference already exists/i.test(stderr)) return "moved";
  throw new Error(`feed ref update failed: ${stderr}`);
}

const PREPARED = "feed-prepared.json";
export const MOVED = "the feed branch moved; run this job again";

// The command line's word for the decision: absent is false, and only the two words are accepted.
export function parseAllowEmptyChannel(value: string | string[] | boolean | undefined): boolean {
  if (value === undefined) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("--allow-empty-channel must be true or false");
}

// A channel offers the releases it lists that are not withdrawn.
function offeredCount(feed: string): number {
  const doc = JSON.parse(feed) as { releases: { version: string }[]; withdrawn: string[] };
  const withdrawn = new Set(doc.withdrawn);
  return doc.releases.filter(release => !withdrawn.has(release.version)).length;
}

export type Prepared = { head: string | null; message: string };

export type PrepareIo = {
  head: () => string | null;
  read: (sha: string, file: string) => string | null;
  listedSince?: (version: string) => number | null;
};

// The commit time of the OLDEST commit, in first-parent graph order, whose latest.json lists the version. The whole
// chain is read: a push can append replayed older feeds, so stopping at the first commit that does not list the
// version would let a back-dated tip stand in for the real listing. Every commit that lists it must carry a
// latest.json.sig that verifies under the pinned feed signers (a replay of a signed file is signed, so graph order,
// not the signature, is what keeps it from moving the answer). The head has to list it, or there is no run.
function listsVersion(body: string, version: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || !("releases" in parsed)) return false;
  const releases = (parsed as { releases?: unknown }).releases;
  if (!Array.isArray(releases)) return false;
  return releases.some(release => typeof release === "object" && release !== null && (release as { version?: unknown }).version === version);
}

// GET a commit: committer.date and the first parent's sha.
// https://docs.github.com/en/rest/git/commits#get-a-commit (read 2026-10-24)
function commitOf(repository: string, sha: string): { parent: string | null; at: string } {
  const run = gh([
    "api",
    `/repos/${repository}/git/commits/${sha}`,
    "--jq",
    '[.committer.date, (.parents[0].sha // "")] | @tsv',
  ]);
  if (!run.ok) throw new Error(`commit failed: ${run.stderr}`);
  const line = run.stdout.split("\n")[0] ?? "";
  const tab = line.indexOf("\t");
  if (tab < 1) throw new Error(`commit failed: ${line}`);
  const parent = line.slice(tab + 1).trim();
  return { at: line.slice(0, tab), parent: parent === "" ? null : parent };
}

export function listedSince(
  repository: string,
  version: string,
  head: string,
  trust: { signers: string; scratch: string },
  io: {
    read: (sha: string, file: string) => string | null;
    commit: (sha: string) => { parent: string | null; at: string };
  } = {
    read: (sha, file) => readAt(repository, sha, file),
    commit: sha => commitOf(repository, sha),
  },
): number | null {
  let sha: string | null = head;
  let oldest: number | null = null;
  while (sha !== null && sha !== "") {
    const body = io.read(sha, "latest.json");
    const lists = body !== null && listsVersion(body, version);
    if (!lists && sha === head) return null;
    const commit = io.commit(sha);
    if (lists) {
      const signature = io.read(sha, "latest.json.sig");
      if (signature === null) throw new Error(`the feed branch commit ${sha} lists ${version} in a latest.json that is not signed by the feed key`);
      try {
        verifyFeed(trust.signers, body, signature, trust.scratch);
      } catch {
        throw new Error(`the feed branch commit ${sha} lists ${version} in a latest.json that is not signed by the feed key`);
      }
      const at = Date.parse(commit.at);
      if (!Number.isInteger(at)) throw new Error(`not a time: ${commit.at}`);
      oldest = at;
    }
    sha = commit.parent;
  }
  return oldest;
}

// A branch that exists must hold both feeds. A missing file is never a reason to start that feed again
// at 1: machines that saw a higher number would reject every later feed (design §9.5).
export function prepareFeeds(p: {
  repository: string; dir: string; signers: string; scratch: string; now: number;
} & ({ mode: "publish"; version: string; manifestPath: string; manifestUrl: string; keySetVersion: number } | { mode: "resign" } | { mode: "withdraw"; version: string; allowEmptyChannel?: boolean } | { mode: "promote"; version: string }),
io: PrepareIo = { head: () => readFeedHead(p.repository), read: (sha, file) => readAt(p.repository, sha, file) }): "absent" | "ready" {
  if ((p.mode === "withdraw" || p.mode === "promote") && parseVersion(p.version) === null) throw new Error(`not a version: ${p.version}`);
  mkdirSync(p.dir, { recursive: true });
  for (const file of [...FEED_FILES, PREPARED]) rmSync(join(p.dir, file), { force: true });
  const head = io.head();
  if (p.mode === "resign" && head === null) return "absent";
  if (p.mode === "withdraw" && head === null) throw new Error("no feed branch to withdraw from");
  if (p.mode === "promote" && head === null) throw new Error("no feed branch to promote from");
  // Both feeds and both signatures are looked for before any is checked, so a missing file is the first error.
  const found = head === null ? null : Object.fromEntries(FEED_FILES.map(file => [file, io.read(head, file)])) as Record<(typeof FEED_FILES)[number], string | null>;
  if (found !== null) {
    for (const name of ["latest.json", "stable.json"] as const) {
      if (found[name] === null) throw new Error(`the feed branch is at ${head} but ${name} is missing; refusing to start the feed again at 1`);
      if (found[`${name}.sig`] === null) throw new Error(`${name} has no signature`);
    }
  }
  const verified = (name: "latest.json" | "stable.json") => {
    const body = found?.[name] ?? null;
    if (body === null) return null;
    verifyFeed(p.signers, body, found?.[`${name}.sig`] ?? "", p.scratch);
    return body;
  };
  const latest = verified("latest.json");
  const stable = verified("stable.json");
  if (p.mode === "resign" || p.mode === "withdraw" || p.mode === "promote") {
    if (latest === null || stable === null) throw new Error(`feed ${latest === null ? "latest" : "stable"} is missing at ${head}`);
    if (p.mode === "withdraw") {
      const listed = ChannelFeedSchema.parse(JSON.parse(latest));
      if (!listed.releases.some(release => release.version === p.version)) throw new Error(`${p.version} is not in the latest feed`);
      const nextLatest = withdrawRelease(latest, p.version, p.now);
      const nextStable = withdrawRelease(stable, p.version, p.now);
      if (p.allowEmptyChannel !== true) {
        for (const [channel, before, after] of [["latest", latest, nextLatest], ["stable", stable, nextStable]] as const) {
          if (offeredCount(before) > 0 && offeredCount(after) === 0) {
            throw new Error(`withdrawing ${p.version} would leave the ${channel} feed offering nothing; set allow_empty_channel to true to do it`);
          }
        }
      }
      writeFileSync(join(p.dir, "latest.json"), nextLatest);
      writeFileSync(join(p.dir, "stable.json"), nextStable);
    } else if (p.mode === "promote") {
      const latestFeed = ChannelFeedSchema.parse(JSON.parse(latest));
      const stableFeed = ChannelFeedSchema.parse(JSON.parse(stable));
      if (!latestFeed.releases.some(release => release.version === p.version)) throw new Error(`${p.version} is not in the latest feed`);
      if (latestFeed.withdrawn.includes(p.version) || stableFeed.withdrawn.includes(p.version)) throw new Error(`${p.version} is withdrawn`);
      if (stableFeed.releases.some(release => release.version === p.version)) throw new Error(`${p.version} is already in the stable feed`);
      const since = (io.listedSince ?? ((version: string) => {
        if (head === null) throw new Error("no feed branch to promote from");
        return listedSince(p.repository, version, head, { signers: p.signers, scratch: p.scratch });
      }))(p.version);
      if (since === null) throw new Error(`cannot tell when ${p.version} was first listed on latest`);
      if (p.now - since < PROMOTION_WAIT_MS) {
        const days = ((p.now - since) / (24 * 60 * 60 * 1000)).toFixed(1);
        throw new Error(`${p.version} has been on latest for ${days} days (since ${isoUtc(since)}, when the feed commit first listed it); promotion needs 7`);
      }
      const nextLatest = resignFeed(latest, p.now);
      const nextStable = promoteRelease(stable, latest, p.version, p.now);
      writeFileSync(join(p.dir, "latest.json"), nextLatest);
      writeFileSync(join(p.dir, "stable.json"), nextStable);
    } else {
      writeFileSync(join(p.dir, "latest.json"), resignFeed(latest, p.now));
      writeFileSync(join(p.dir, "stable.json"), resignFeed(stable, p.now));
    }
  } else {
    const manifest = readFileSync(p.manifestPath);
    writeFileSync(join(p.dir, "latest.json"), publishRelease(latest, {
      channel: "latest", now: p.now, keySetVersion: p.keySetVersion,
      entry: {
        version: p.version, manifest: p.manifestUrl, manifestSize: manifest.length,
        manifestSha256: createHash("sha256").update(manifest).digest("hex"),
      },
    }));
    writeFileSync(join(p.dir, "stable.json"), stable ?? emptyFeed({ channel: "stable", now: p.now, keySetVersion: p.keySetVersion }));
  }
  const prepared: Prepared = {
    head,
    message: p.mode === "publish" ? "Publish the channel feeds" : p.mode === "resign" ? "Re-sign the channel feeds" : p.mode === "withdraw" ? `Withdraw ${p.version}` : `Promote ${p.version} to stable`,
  };
  writeFileSync(join(p.dir, PREPARED), JSON.stringify(prepared));
  return "ready";
}

export type CommitIo = {
  head: () => string | null;
  write: (parent: string | null, dir: string, message: string) => "ok" | "moved";
};

export function commitFeeds(
  p: { repository: string; dir: string; signers: string; scratch: string },
  io: CommitIo = { head: () => readFeedHead(p.repository), write: (parent, dir, message) => writeRef(p.repository, parent, dir, message) },
): void {
  const prepared = JSON.parse(readFileSync(join(p.dir, PREPARED), "utf8")) as Prepared;
  for (const name of ["latest", "stable"] as const) {
    const file = join(p.dir, `${name}.json`);
    const sig = join(p.dir, `${name}.json.sig`);
    if (!existsSync(sig)) throw new Error(`${name}.json is not signed`);
    verifyFeed(p.signers, readFileSync(file, "utf8"), readFileSync(sig, "utf8"), p.scratch);
  }
  if (io.head() !== prepared.head) throw new Error(MOVED);
  if (io.write(prepared.head, p.dir, prepared.message) !== "ok") throw new Error(MOVED);
}
