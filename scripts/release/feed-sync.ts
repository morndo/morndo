// Push the feed branch only if it still points at the commit we read.
// Update a reference leaves force false, so a moved branch is rejected
// (https://docs.github.com/en/rest/git/refs#update-a-reference, read 2026-10-13).
// The caller then reads that new head and tries again.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyFeed, publishRelease, resignFeed } from "./feed.ts";
import { freshSite, type SiteHead } from "./pages.ts";
import { FEED_NAMESPACE, signBytes } from "./sign.ts";

const FEED_FILES = ["latest.json", "latest.json.sig", "stable.json", "stable.json.sig"] as const;

export function syncFeed(p: {
  readHead: () => string | null;
  prepare: (head: string | null) => void;
  commit: (parent: string | null) => "ok" | "moved";
  attempts?: number;
}): void {
  const attempts = p.attempts ?? 5;
  for (let n = 1; n <= attempts; n++) {
    const head = p.readHead();
    p.prepare(head);
    if (p.commit(head) === "ok") return;
  }
  throw new Error("the feed branch moved on every attempt");
}

type Gh = { ok: boolean; stdout: string; stderr: string };

function gh(args: string[], input?: string): Gh {
  const run = spawnSync("gh", args, { encoding: "utf8", input });
  return { ok: run.status === 0, stdout: run.stdout ?? "", stderr: `${run.stderr ?? ""}\n${run.stdout ?? ""}` };
}

function must(run: Gh, what: string): string {
  if (!run.ok) throw new Error(`${what} failed: ${run.stderr}`);
  return run.stdout.trim();
}

export function materialiseFeed(repository: string, dir: string): void {
  freshSite(
    () => readSiteHead(repository),
    head => {
      mkdirSync(dir, { recursive: true });
      for (const file of FEED_FILES) {
        const body = readAt(repository, head.sha, file);
        if (body === null) throw new Error(`feed ${file} is missing at ${head.sha}`);
        writeFileSync(join(dir, file), body);
      }
      return head;
    },
  );
}

function readSiteHead(repository: string): SiteHead {
  const sha = readFeedHead(repository);
  if (sha === null) throw new Error("branch feed has no feed yet");
  const latest = readAt(repository, sha, "latest.json");
  if (latest === null) throw new Error("branch feed has no feed yet");
  const parsed: unknown = JSON.parse(latest);
  if (typeof parsed !== "object" || parsed === null || !("seq" in parsed) || typeof parsed.seq !== "number") {
    throw new Error("feed has no seq");
  }
  return { sha, seq: parsed.seq };
}

export function readFeedHead(repository: string): string | null {
  const run = gh(["api", `/repos/${repository}/git/ref/heads/feed`, "--jq", ".object.sha"]);
  if (run.ok) return run.stdout.trim();
  if (/\b404\b/.test(run.stderr)) return null;
  throw new Error(`feed head failed: ${run.stderr}`);
}

function readAt(repository: string, sha: string, file: string): string | null {
  const run = gh(["api", "-H", "Accept: application/vnd.github.raw+json", `/repos/${repository}/contents/${file}?ref=${sha}`]);
  if (run.ok) return run.stdout;
  if (/\b404\b/.test(run.stderr)) return null;
  throw new Error(`feed ${file} at ${sha} failed: ${run.stderr}`);
}

function verifyFeed(signers: string, bytes: string, signature: string, dir: string): void {
  const sig = join(dir, "payload.sig");
  writeFileSync(sig, signature);
  const run = spawnSync("ssh-keygen", ["-Y", "verify", "-f", signers, "-I", FEED_NAMESPACE, "-n", FEED_NAMESPACE, "-s", sig], {
    input: bytes, encoding: "utf8",
  });
  rmSync(sig, { force: true });
  if (run.status !== 0) throw new Error(`feed signature failed: ${run.stderr}`);
}

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
// https://docs.github.com/en/rest/git/refs#update-a-reference (read 2026-10-13)
// Retry only when the body says the update was not a fast forward or the reference moved.
export function refUpdateResult(ok: boolean, stderr: string): "ok" | "moved" {
  if (ok) return "ok";
  if (/not a fast forward/i.test(stderr) || /reference moved/i.test(stderr)) return "moved";
  throw new Error(`feed ref update failed: ${stderr}`);
}

export function publishChannelFeeds(p: {
  repository: string; dir: string; version: string; manifestPath: string; manifestUrl: string;
  now: number; keySetVersion: number; keyPath: string; signers: string; scratch: string;
}): void {
  const manifest = readFileSync(p.manifestPath);
  syncFeed({
    readHead: () => readFeedHead(p.repository),
    prepare: head => {
      mkdirSync(p.dir, { recursive: true });
      for (const file of FEED_FILES) rmSync(join(p.dir, file), { force: true });
      const latest = head === null ? null : readAt(p.repository, head, "latest.json");
      const latestSig = head === null ? null : readAt(p.repository, head, "latest.json.sig");
      if (latest !== null) {
        if (latestSig === null) throw new Error("latest.json has no signature");
        verifyFeed(p.signers, latest, latestSig, p.scratch);
      }
      const added = publishRelease(latest, {
        channel: "latest", now: p.now, keySetVersion: p.keySetVersion,
        entry: {
          version: p.version, manifest: p.manifestUrl, manifestSize: manifest.length,
          manifestSha256: createHash("sha256").update(manifest).digest("hex"),
        },
      });
      writeFileSync(join(p.dir, "latest.json"), added);
      const stable = head === null ? null : readAt(p.repository, head, "stable.json");
      const stableSig = head === null ? null : readAt(p.repository, head, "stable.json.sig");
      if (stable !== null) {
        if (stableSig === null) throw new Error("stable.json has no signature");
        verifyFeed(p.signers, stable, stableSig, p.scratch);
        writeFileSync(join(p.dir, "stable.json"), stable);
      } else {
        writeFileSync(join(p.dir, "stable.json"), emptyFeed({ channel: "stable", now: p.now, keySetVersion: p.keySetVersion }));
      }
      for (const name of ["latest.json", "stable.json"] as const) {
        const bytes = readFileSync(join(p.dir, name));
        writeFileSync(join(p.dir, `${name}.sig`), signBytes({ bytes, keyPath: p.keyPath, namespace: FEED_NAMESPACE, dir: p.scratch }));
      }
    },
    commit: parent => writeRef(p.repository, parent, p.dir, "Publish the channel feeds"),
  });
}

export function resignChannelFeeds(p: {
  repository: string; dir: string; now: number; keyPath: string; signers: string; scratch: string;
}): "absent" | "resigned" {
  let outcome: "absent" | "resigned" = "absent";
  syncFeed({
    readHead: () => readFeedHead(p.repository),
    prepare: head => {
      mkdirSync(p.dir, { recursive: true });
      for (const file of FEED_FILES) rmSync(join(p.dir, file), { force: true });
      if (head === null) { outcome = "absent"; return; }
      const latest = readAt(p.repository, head, "latest.json");
      if (latest === null) { outcome = "absent"; return; }
      outcome = "resigned";
      for (const channel of ["latest", "stable"] as const) {
        const body = channel === "latest" ? latest : readAt(p.repository, head, `${channel}.json`);
        const signature = readAt(p.repository, head, `${channel}.json.sig`);
        if (body === null || signature === null) throw new Error(`feed ${channel} is missing at ${head}`);
        verifyFeed(p.signers, body, signature, p.scratch);
        const next = resignFeed(body, p.now);
        writeFileSync(join(p.dir, `${channel}.json`), next);
        writeFileSync(join(p.dir, `${channel}.json.sig`), signBytes({
          bytes: Buffer.from(next), keyPath: p.keyPath, namespace: FEED_NAMESPACE, dir: p.scratch,
        }));
      }
    },
    commit: parent => outcome === "absent" ? "ok" : writeRef(p.repository, parent, p.dir, "Re-sign the channel feeds"),
  });
  return outcome;
}
