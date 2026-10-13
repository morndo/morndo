// Pages reads the feed branch and writes the site. This file loads no app code:
// gh and ssh-keygen are enough, so the job does not need npm ci.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  const scratch = join(dir, ".check");
  mkdirSync(scratch, { recursive: true });
  for (const channel of ["latest", "stable"] as const) {
    const body = files.find(file => file.name === `${channel}.json`)?.body;
    const signature = files.find(file => file.name === `${channel}.json.sig`)?.body;
    if (body === undefined || signature === undefined) throw new Error(`feed ${channel} is missing`);
    verifyFeed(signers, body, signature, scratch);
  }
  rmSync(scratch, { recursive: true, force: true });
  for (const file of files) writeFileSync(join(dir, file.name), file.body);
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
  const parsed: unknown = JSON.parse(latest);
  if (typeof parsed !== "object" || parsed === null || !("seq" in parsed) || typeof parsed.seq !== "number") {
    throw new Error("feed has no seq");
  }
  return { sha, seq: parsed.seq };
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
