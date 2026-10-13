// Pages reads the feed branch and writes the site. This file loads no app code:
// gh and ssh-keygen are enough, so the job does not need npm ci.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { freshSite, type SiteHead } from "./pages.ts";
import { FEED_NAMESPACE } from "./sign.ts";

export const FEED_FILES = ["latest.json", "latest.json.sig", "stable.json", "stable.json.sig"] as const;

export type Gh = { ok: boolean; stdout: string; stderr: string };

export function gh(args: string[], input?: string): Gh {
  const run = spawnSync("gh", args, { encoding: "utf8", input });
  return { ok: run.status === 0, stdout: run.stdout ?? "", stderr: `${run.stderr ?? ""}\n${run.stdout ?? ""}` };
}

export function must(run: Gh, what: string): string {
  if (!run.ok) throw new Error(`${what} failed: ${run.stderr}`);
  return run.stdout.trim();
}

export function verifyFeed(signers: string, bytes: string, signature: string, dir: string): void {
  const sig = join(dir, "payload.sig");
  writeFileSync(sig, signature);
  const run = spawnSync("ssh-keygen", ["-Y", "verify", "-f", signers, "-I", FEED_NAMESPACE, "-n", FEED_NAMESPACE, "-s", sig], {
    input: bytes, encoding: "utf8",
  });
  rmSync(sig, { force: true });
  if (run.status !== 0) throw new Error(`feed signature failed: ${run.stderr}`);
}

export function readFeedHead(repository: string): string | null {
  const run = gh(["api", `/repos/${repository}/git/ref/heads/feed`, "--jq", ".object.sha"]);
  if (run.ok) return run.stdout.trim();
  if (/\b404\b/.test(run.stderr)) return null;
  throw new Error(`feed head failed: ${run.stderr}`);
}

export function readAt(repository: string, sha: string, file: string): string | null {
  const run = gh(["api", "-H", "Accept: application/vnd.github.raw+json", `/repos/${repository}/contents/${file}?ref=${sha}`]);
  if (run.ok) return run.stdout;
  if (/\b404\b/.test(run.stderr)) return null;
  throw new Error(`feed ${file} at ${sha} failed: ${run.stderr}`);
}

export function writeVerifiedSite(dir: string, signers: string, files: readonly { name: string; body: string }[]): void {
  const scratch = mkdtempSync(join(tmpdir(), "morndo-feed-"));
  try {
    for (const channel of ["latest", "stable"] as const) {
      const body = files.find(file => file.name === `${channel}.json`)?.body;
      const signature = files.find(file => file.name === `${channel}.json.sig`)?.body;
      if (body === undefined || signature === undefined) throw new Error(`feed ${channel} is missing`);
      verifyFeed(signers, body, signature, scratch);
      feedDocument(body, channel);
    }
    mkdirSync(dir, { recursive: true });
    for (const file of files) writeFileSync(join(dir, file.name), file.body);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function materialiseFeed(repository: string, dir: string, signers = "trust/feed_allowed_signers"): void {
  freshSite(
    () => readSiteHead(repository),
    head => {
      const files = FEED_FILES.map(name => {
        const body = readAt(repository, head.sha, name);
        if (body === null) throw new Error(`feed ${name} is missing at ${head.sha}`);
        return { name, body };
      });
      writeVerifiedSite(dir, signers, files);
      return head;
    },
  );
}

function readSiteHead(repository: string): SiteHead {
  const sha = readFeedHead(repository);
  if (sha === null) throw new Error("branch feed has no feed yet");
  const latest = readAt(repository, sha, "latest.json");
  if (latest === null) throw new Error("branch feed has no feed yet");
  return { sha, seq: feedDocument(latest, "latest") };
}

// The same document the protocol's ChannelFeed checks, without loading that package:
// exact keys, schema 1, the channel named by the file, a seq and key-set version of
// at least 1, UTC instants, and arrays for releases and withdrawals.
const FEED_KEYS = ["schema", "channel", "seq", "issuedAt", "expiresAt", "keySetVersion", "releases", "withdrawn"] as const;

function feedDocument(body: string, channel: "latest" | "stable"): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("feed is not the wire's shape");
  }
  if (!isRecord(parsed)) throw new Error("feed is not the wire's shape");
  const keys = Object.keys(parsed);
  if (keys.length !== FEED_KEYS.length || FEED_KEYS.some(key => !Object.hasOwn(parsed, key))) {
    throw new Error("feed is not the wire's shape");
  }
  if (parsed.schema !== 1 || parsed.channel !== channel) throw new Error("feed is not the wire's shape");
  if (!whole(parsed.seq) || parsed.seq < 1) throw new Error("feed is not the wire's shape");
  if (!instant(parsed.issuedAt) || !instant(parsed.expiresAt)) throw new Error("feed is not the wire's shape");
  if (!whole(parsed.keySetVersion) || parsed.keySetVersion < 1) throw new Error("feed is not the wire's shape");
  if (!Array.isArray(parsed.releases) || !parsed.releases.every(isRecord)) throw new Error("feed is not the wire's shape");
  if (!Array.isArray(parsed.withdrawn) || !parsed.withdrawn.every(item => typeof item === "string")) {
    throw new Error("feed is not the wire's shape");
  }
  return parsed.seq;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function whole(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function instant(value: unknown): boolean {
  return typeof value === "string" && value.endsWith("Z") && Number.isFinite(Date.parse(value));
}

function main(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      repository: { type: "string" },
      dir: { type: "string" },
      signers: { type: "string" },
    },
    strict: true,
  });
  if (typeof values.repository !== "string" || values.repository === "" || typeof values.dir !== "string" || values.dir === "") {
    throw new Error("usage: feed-site --repository OWNER/REPO --dir DIR [--signers FILE]");
  }
  materialiseFeed(
    values.repository,
    values.dir,
    typeof values.signers === "string" && values.signers !== "" ? values.signers : "trust/feed_allowed_signers",
  );
}

// import.meta.main: https://nodejs.org/docs/latest-v24.x/api/esm.html#importmetamain
// (added in v24.2.0, read 2026-10-13).
if (import.meta.main) main(process.argv.slice(2));
