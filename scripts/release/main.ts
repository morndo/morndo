// The release workflow's commands. The checks live in the neighbouring modules; this only reads
// flags and files. import.meta.main: https://nodejs.org/docs/latest-v24.x/api/esm.html#importmetamain
// (added in v24.2.0, read 2026-10-13).
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { parseArgs } from "node:util";
import type { Channel, Platform } from "@morndo/domain";
import { packTree, type TreeFile } from "./archive.ts";
import { compileWorkspaces } from "./compile.ts";
import { sha256Sums } from "./checksums.ts";
import { emptyFeed, publishRelease, resignFeed } from "./feed.ts";
import { materialiseFeed } from "./feed-site.ts";
import { keySetVersion } from "./key-set.ts";
import { commitFeeds, parseAllowEmptyChannel, prepareFeeds } from "./feed-sync.ts";
import { artifactName, buildManifest, declaredSchemas, protocolRange, type ArtifactInput } from "./manifest.ts";
import { BUNDLED_NODE, newerNode24 } from "./node-pin.ts";
import { FEED_NAMESPACE, RELEASE_NAMESPACE, signBytes } from "./sign.ts";
import { stageRelease } from "./stage.ts";
import { stampVersion } from "./stamp.ts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function platform(text: string): Platform {
  if (text === "linux-x64" || text === "linux-arm64" || text === "darwin-arm64") return text;
  throw new Error(`unknown platform ${text}`);
}

function channel(text: string): Channel {
  if (text === "stable" || text === "latest") return text;
  throw new Error(`unknown channel ${text}`);
}

function flag(values: Record<string, string | string[] | boolean | undefined>, name: string): string {
  const value = values[name];
  if (typeof value !== "string" || value === "") throw new Error(`missing --${name}`);
  return value;
}

function treeFiles(root: string): TreeFile[] {
  const out: TreeFile[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        out.push({ path: rel, mode: "0555", link: readlinkSync(abs).split(sep).join("/") });
      } else if (st.isDirectory()) {
        if (readdirSync(abs).length === 0) out.push({ path: rel, mode: "0555", directory: true });
        else walk(abs, rel);
      }
      else if (st.isFile()) {
        const mode = rel.startsWith("bin/") || rel.startsWith("node/bin/") ? "0555" : "0444";
        out.push({ path: rel, bytes: readFileSync(abs), mode });
      }
    }
  };
  walk(root, "");
  return out;
}

function main(argv: string[]): void {
  const [command, ...rest] = argv;
  if (!command) throw new Error("usage: stage | compile | pack | manifest | stamp | sign | feed-empty | feed-add | feed-resign | feed-resign-prepare | feed-withdraw-prepare | feed-promote-prepare | feed-publish-prepare | feed-commit | key-set | feed-site | sums | node-check");
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      repo: { type: "string" }, node: { type: "string" }, dest: { type: "string" }, version: { type: "string" }, compiled: { type: "string" },
      root: { type: "string" }, out: { type: "string" }, mtime: { type: "string" },
      commit: { type: "string" }, "published-at": { type: "string" }, repository: { type: "string" },
      artifact: { type: "string", multiple: true }, files: { type: "string", multiple: true },
      in: { type: "string" }, key: { type: "string" }, namespace: { type: "string" },
      channel: { type: "string" }, existing: { type: "string" }, manifest: { type: "string" },
      "manifest-url": { type: "string" }, now: { type: "string" }, "key-set": { type: "string" },
      dir: { type: "string" }, signers: { type: "string" }, scratch: { type: "string" }, "allow-empty-channel": { type: "string" },
      index: { type: "string" }, keys: { type: "string" },
    },
    strict: true,
    allowPositionals: true,
  });
  switch (command) {
    case "compile":
      compileWorkspaces(flag(values, "repo"), flag(values, "out"));
      return;
    case "stage":
      stageRelease({
        repo: flag(values, "repo"), nodeDir: flag(values, "node"), dest: flag(values, "dest"), version: flag(values, "version"), commit: flag(values, "commit"),
        ...(typeof values.compiled === "string" ? { compiled: values.compiled } : {}),
      });
      return;
    case "pack": {
      const mtime = Number(flag(values, "mtime"));
      writeFileSync(flag(values, "out"), packTree(treeFiles(flag(values, "root")), mtime));
      return;
    }
    case "manifest": {
      const version = flag(values, "version");
      const files = new Map((values.files ?? []).map(pair));
      const artifacts: ArtifactInput[] = (values.artifact ?? []).map(item => {
        const [name, archivePath] = pair(item);
        const host = platform(name);
        const fileList = files.get(host);
        if (!fileList) throw new Error(`missing --files for ${host}`);
        const archive = readFileSync(archivePath);
        const list = readFileSync(fileList);
        return { platform: host, name: artifactName(version, host), size: archive.length, sha256: sha256(archive), filesSha256: sha256(list), node: BUNDLED_NODE };
      });
      writeFileSync(flag(values, "out"), buildManifest({
        version, commit: flag(values, "commit"), publishedAt: Number(flag(values, "published-at")),
        repository: flag(values, "repository"), protocol: protocolRange(), schemas: declaredSchemas(), artifacts,
      }));
      return;
    }
    case "stamp":
      writeFileSync(flag(values, "out"), stampVersion(readFileSync(flag(values, "in"), "utf8"), flag(values, "version")), { mode: 0o755 });
      return;
    case "sign": {
      const namespace = flag(values, "namespace");
      if (namespace !== RELEASE_NAMESPACE && namespace !== FEED_NAMESPACE) throw new Error(`unknown namespace ${namespace}`);
      const bytes = readFileSync(flag(values, "in"));
      writeFileSync(flag(values, "out"), signBytes({ bytes, keyPath: flag(values, "key"), namespace, dir: flag(values, "dest") }));
      return;
    }
    case "feed-empty":
      writeFileSync(flag(values, "out"), emptyFeed({ channel: channel(flag(values, "channel")), now: Number(flag(values, "now")), keySetVersion: Number(flag(values, "key-set")) }));
      return;
    case "feed-add": {
      const manifestPath = flag(values, "manifest");
      const body = readFileSync(manifestPath);
      const existing = values.existing ? readFileSync(values.existing, "utf8") : null;
      writeFileSync(flag(values, "out"), publishRelease(existing, {
        channel: channel(flag(values, "channel")),
        now: Number(flag(values, "now")),
        keySetVersion: Number(flag(values, "key-set")),
        entry: {
          version: flag(values, "version"),
          manifest: flag(values, "manifest-url"),
          manifestSize: body.length,
          manifestSha256: sha256(body),
        },
      }));
      return;
    }
    case "feed-resign":
      writeFileSync(flag(values, "out"), resignFeed(readFileSync(flag(values, "in"), "utf8"), Number(flag(values, "now"))));
      return;
    case "feed-resign-prepare": {
      const outcome = prepareFeeds({
        mode: "resign", repository: flag(values, "repository"), dir: flag(values, "dir"), now: Number(flag(values, "now")),
        signers: flag(values, "signers"), scratch: flag(values, "scratch"),
      });
      process.stdout.write(`${outcome}\n`);
      return;
    }
    case "feed-withdraw-prepare": {
      const outcome = prepareFeeds({
        mode: "withdraw", version: flag(values, "version"), repository: flag(values, "repository"), dir: flag(values, "dir"),
        now: Number(flag(values, "now")), signers: flag(values, "signers"), scratch: flag(values, "scratch"),
        allowEmptyChannel: parseAllowEmptyChannel(values["allow-empty-channel"]),
      });
      process.stdout.write(`${outcome}\n`);
      return;
    }
    case "feed-promote-prepare": {
      const outcome = prepareFeeds({
        mode: "promote", version: flag(values, "version"), repository: flag(values, "repository"), dir: flag(values, "dir"),
        now: Number(flag(values, "now")), signers: flag(values, "signers"), scratch: flag(values, "scratch"),
      });
      process.stdout.write(`${outcome}\n`);
      return;
    }
    case "key-set":
      process.stdout.write(`${keySetVersion(flag(values, "keys"))}\n`);
      return;
    case "feed-site":
      materialiseFeed(
        flag(values, "repository"),
        flag(values, "dir"),
        typeof values.signers === "string" && values.signers !== "" ? values.signers : "trust/feed_allowed_signers",
      );
      return;
    case "feed-publish-prepare":
      prepareFeeds({
        mode: "publish", repository: flag(values, "repository"), dir: flag(values, "dir"), version: flag(values, "version"),
        manifestPath: flag(values, "manifest"), manifestUrl: flag(values, "manifest-url"),
        now: Number(flag(values, "now")), keySetVersion: Number(flag(values, "key-set")),
        signers: flag(values, "signers"), scratch: flag(values, "scratch"),
      });
      return;
    case "feed-commit":
      commitFeeds({ repository: flag(values, "repository"), dir: flag(values, "dir"), signers: flag(values, "signers"), scratch: flag(values, "scratch") });
      return;
    case "sums":
      writeFileSync(flag(values, "out"), sha256Sums(positionals.map(name => ({ name: name.split("/").pop() ?? name, bytes: readFileSync(name) }))));
      return;
    case "node-check": {
      const index: unknown = JSON.parse(readFileSync(flag(values, "index"), "utf8"));
      if (!Array.isArray(index)) throw new Error("node index is not a list");
      const rows = index.flatMap(row => {
        if (typeof row === "object" && row !== null && "version" in row && typeof row.version === "string") return [{ version: row.version }];
        return [];
      });
      const newer = newerNode24(rows);
      if (newer) throw new Error(`pinned Node ${BUNDLED_NODE} is behind ${newer}`);
      process.stdout.write(`Node ${BUNDLED_NODE} is current on the 24 line\n`);
      return;
    }
    default:
      throw new Error(`unknown command ${command}`);
  }
}

function pair(item: string): [string, string] {
  const eq = item.indexOf("=");
  if (eq <= 0) throw new Error(`expected name=path, got ${item}`);
  return [item.slice(0, eq), item.slice(eq + 1)];
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "release command failed"}\n`);
    process.exit(1);
  }
}
