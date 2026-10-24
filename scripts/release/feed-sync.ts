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
import { emptyFeed, publishRelease, resignFeed, withdrawRelease } from "./feed.ts";
import { FEED_FILES, gh, must, readAt, readFeedHead, verifyFeed } from "./feed-site.ts";

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

export type Prepared = { head: string | null; message: string };

export type PrepareIo = { head: () => string | null; read: (sha: string, file: string) => string | null };

// A branch that exists must hold both feeds. A missing file is never a reason to start that feed again
// at 1: machines that saw a higher number would reject every later feed (design §9.5).
export function prepareFeeds(p: {
  repository: string; dir: string; signers: string; scratch: string; now: number;
} & ({ mode: "publish"; version: string; manifestPath: string; manifestUrl: string; keySetVersion: number } | { mode: "resign" } | { mode: "withdraw"; version: string }),
io: PrepareIo = { head: () => readFeedHead(p.repository), read: (sha, file) => readAt(p.repository, sha, file) }): "absent" | "ready" {
  if (p.mode === "withdraw" && parseVersion(p.version) === null) throw new Error(`not a version: ${p.version}`);
  mkdirSync(p.dir, { recursive: true });
  for (const file of [...FEED_FILES, PREPARED]) rmSync(join(p.dir, file), { force: true });
  const head = io.head();
  if (p.mode === "resign" && head === null) return "absent";
  if (p.mode === "withdraw" && head === null) throw new Error("no feed branch to withdraw from");
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
  if (p.mode === "resign" || p.mode === "withdraw") {
    if (latest === null || stable === null) throw new Error(`feed ${latest === null ? "latest" : "stable"} is missing at ${head}`);
    if (p.mode === "withdraw") {
      const listed = ChannelFeedSchema.parse(JSON.parse(latest));
      if (!listed.releases.some(release => release.version === p.version)) throw new Error(`${p.version} is not in the latest feed`);
      const nextLatest = withdrawRelease(latest, p.version, p.now);
      const nextStable = withdrawRelease(stable, p.version, p.now);
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
    message: p.mode === "publish" ? "Publish the channel feeds" : p.mode === "resign" ? "Re-sign the channel feeds" : `Withdraw ${p.version}`,
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
