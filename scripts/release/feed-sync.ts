// The feed branch is written in three steps so the signing key never meets npm code:
// prepare builds the unsigned feeds, a shell step signs them with ssh-keygen, commit verifies
// the signatures and pushes only if the branch still points at the commit prepare read.
// Update a reference leaves force false, so a moved branch is rejected
// (https://docs.github.com/en/rest/git/refs#update-a-reference, read 2026-10-13).
// A moved branch fails the job; running it again reads the new head.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyFeed, publishRelease, resignFeed } from "./feed.ts";
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

export function prepareFeeds(p: {
  repository: string; dir: string; signers: string; scratch: string; now: number;
} & ({ mode: "publish"; version: string; manifestPath: string; manifestUrl: string; keySetVersion: number } | { mode: "resign" })): "absent" | "ready" {
  mkdirSync(p.dir, { recursive: true });
  for (const file of [...FEED_FILES, PREPARED]) rmSync(join(p.dir, file), { force: true });
  const head = readFeedHead(p.repository);
  if (p.mode === "resign" && head === null) return "absent";
  const read = (name: string, sig: string) => {
    const body = head === null ? null : readAt(p.repository, head, name);
    const signature = head === null ? null : readAt(p.repository, head, sig);
    if (body !== null) {
      if (signature === null) throw new Error(`${name} has no signature`);
      verifyFeed(p.signers, body, signature, p.scratch);
    }
    return body;
  };
  const latest = read("latest.json", "latest.json.sig");
  const stable = read("stable.json", "stable.json.sig");
  if (p.mode === "resign") {
    if (latest === null || stable === null) throw new Error(`feed ${latest === null ? "latest" : "stable"} is missing at ${head}`);
    writeFileSync(join(p.dir, "latest.json"), resignFeed(latest, p.now));
    writeFileSync(join(p.dir, "stable.json"), resignFeed(stable, p.now));
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
  const prepared: Prepared = { head, message: p.mode === "publish" ? "Publish the channel feeds" : "Re-sign the channel feeds" };
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
