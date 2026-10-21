// The versioned-directories installer (design §4.6 Installer, §5, §6.1 steps 4–6): one directory per Version
// under the releases directory, a .staging-<version>/ while a Version is unpacked and checked, and rename(2)
// — atomic — to promote. It never throws for a bad archive: the staging tree goes and the reason comes back
// (RL1 file_list: every file against the signed list, nothing extra, no path outside). Digests come from the
// SSH-signature verifier, node:crypto's one door (§4.7); this adapter adds no crypto of its own.
import { execFile } from "node:child_process";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statfsSync, writeFileSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { parseVersion } from "@morndo/domain";
import { FileListSchema } from "@morndo/protocol";
import type { Installer, Layout, TreeFinding } from "../application/ports.ts";
import { extractTar, TarRefused, type TarEntry } from "./tar-read.ts";
import { SshSigVerifier } from "./verifier-sshsig.ts";

// What the self-test runs: the staged launcher, no shell, and PATH the only thing it inherits.
export type Run = (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string }>;

const execFileRun: Run = (cmd, args, timeoutMs) =>
  new Promise(resolve => {
    execFile(cmd, args, { encoding: "utf8", timeout: timeoutMs, env: { PATH: process.env.PATH ?? "" } }, (error, stdout) => {
      // a non-zero exit is a number; a spawn failure (ENOENT, ETIMEDOUT) is not, and reads as 127
      resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 127, stdout: stdout ?? "" });
    });
  });

// The same time the signed documents write (scripts/release/json.ts): UTC, a Z, no fraction.
const isoUtc = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export class DirsInstaller implements Installer {
  private readonly releases: string;
  private readonly run: Run;
  private readonly hashes = new SshSigVerifier();

  constructor(o: { releases: string; run?: Run }) {
    this.releases = o.releases;
    this.run = o.run ?? execFileRun;
  }

  private staging(version: string): string { return join(this.releases, `.staging-${version}`); }

  layout(): Layout {
    // ours only: a link whose target is a plain sibling name that parses as a Version (§5). Anything else —
    // ../elsewhere, a name that is not a Version, a missing link — is not this updater's install.
    const read = (name: "current" | "previous" | "good"): string | null => {
      let target: string;
      try { target = readlinkSync(join(this.releases, name)); } catch { return null; }
      if (target === "" || target === "." || target === ".." || target.includes("/")) return null;
      return parseVersion(target) === null ? null : target;
    };
    const current = read("current");
    return { method: current !== null ? "updater" : "checkout", current, previous: read("previous"), good: read("good") };
  }

  shippedKeySet(): Uint8Array | null {
    try { return readFileSync(join(this.releases, "current", "trust", "keys.json")); } catch { return null; }
  }

  sweep(): void {
    let entries: Dirent[];
    try { entries = readdirSync(this.releases, { withFileTypes: true }); }
    catch (error) {
      // a machine with nothing installed yet has no releases directory: nothing to sweep, never a failure
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.name.startsWith(".staging-")) continue;
      this.removeTree(join(this.releases, entry.name));
    }
  }

  has(version: string): boolean {
    try { return lstatSync(join(this.releases, version)).isDirectory(); } catch { return false; }
  }

  async unpack(archive: string, version: string, o: { filesSha256: string; maxBytes: number }):
    Promise<{ ok: true } | { ok: false; reason: string }> {
    if (parseVersion(version) === null) return { ok: false, reason: `${version}: not a Version` };
    const staging = this.staging(version);
    this.removeTree(staging);               // a leftover from a killed run, if the sweep did not get it
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    let entries: TarEntry[];
    try {
      entries = await extractTar(archive, staging, { maxBytes: o.maxBytes });
    } catch (error) {
      this.removeTree(staging);
      // Only the archive's fault is a refusal (RL1 file_list). An I/O error is thrown on, so the check records a
      // failure to try again later (exit 75), not a verdict on the release.
      if (error instanceof TarRefused) return { ok: false, reason: error.reason };
      throw error;
    }
    const fault = this.checkAgainstList(staging, entries, o.filesSha256);
    if (fault !== null) { this.removeTree(staging); return { ok: false, reason: fault }; }
    return { ok: true };
  }

  // RL1 file_list: the staging tree against files.json, and files.json against the signed digest. The content
  // is hashed as scripts/release/files.ts lists it — file bytes, link target text, the empty string for a
  // directory — and the modes may only be the pipeline's own kinds (files 0444 or 0555; links and directories
  // 0555, an executable file's 0555 being the only executable mode there is).
  private checkAgainstList(staging: string, entries: readonly TarEntry[], filesSha256: string): string | null {
    const filesEntry = entries.find(e => e.path === "files.json");
    if (filesEntry === undefined || filesEntry.type !== "file") return "files.json: not a file in the archive";
    const listBytes = readFileSync(join(staging, "files.json"));
    if (this.hashes.sha256(listBytes) !== filesSha256) return "files.json: file list digest mismatch";
    let list: { path: string; mode: string; sha256: string }[];
    try { list = FileListSchema.parse(JSON.parse(listBytes.toString("utf8"))); }
    catch { return "files.json: not the wire's shape"; }

    const byPath = new Map(entries.map(e => [e.path, e]));
    const listed = new Set(list.map(e => e.path));
    for (const entry of list) {
      const onDisk = byPath.get(entry.path);
      if (onDisk === undefined) return `${entry.path}: in the file list, not in the archive`;
      if (onDisk.type === "file") {
        if (entry.mode !== "0444" && entry.mode !== "0555") return `${entry.path}: mode ${entry.mode} is not 0444 or 0555`;
        if (this.hashes.sha256(readFileSync(join(staging, entry.path))) !== entry.sha256) return `${entry.path}: content digest mismatch`;
      } else if (onDisk.type === "symlink") {
        if (entry.mode !== "0555") return `${entry.path}: mode ${entry.mode} is not 0555`;
        if (this.hashes.sha256(Buffer.from(readlinkSync(join(staging, entry.path)))) !== entry.sha256) return `${entry.path}: content digest mismatch`;
      } else if (this.hashes.sha256(new Uint8Array(0)) !== entry.sha256) {
        return `${entry.path}: a directory listed with a digest`;
      }
    }
    for (const entry of entries) {
      if (entry.path === "files.json" || listed.has(entry.path)) continue;
      // a directory that only carries listed paths is the tree's own shape; anything else was never signed
      const parent = entry.type === "dir" && list.some(l => l.path.startsWith(`${entry.path}/`));
      if (!parent) return `${entry.path}: not in the file list`;
    }
    // the modes come from the list, never the archive: files now, directories at promotion
    for (const entry of list) {
      if (byPath.get(entry.path)!.type === "file") chmodSync(join(staging, entry.path), parseInt(entry.mode, 8));
    }
    return null;
  }

  async selftest(version: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const done = await this.run(join(this.staging(version), "bin", "morndo"), ["--version"], 20_000);
    if (done.code !== 0) return { ok: false, reason: `bin/morndo --version exited ${done.code}` };
    const printed = done.stdout.trim();
    return printed === version ? { ok: true } : { ok: false, reason: `bin/morndo --version printed ${JSON.stringify(printed)}, not ${version}` };
  }

  promote(version: string, record: { manifestSha256: string; filesSha256: string; at: number }): void {
    const staging = this.staging(version);
    const target = join(this.releases, version);
    if (existsSync(target)) throw new Error(`${version}: already installed`);   // promotion renames, never overwrites
    writeFileSync(join(staging, "install.json"), `${JSON.stringify({
      method: "updater",
      installedAt: isoUtc(record.at),
      manifestSha256: record.manifestSha256,
      filesSha256: record.filesSha256,
    }, null, 2)}\n`);
    chmodSync(join(staging, "install.json"), 0o444);
    // read-only from here (§5): every directory 0555, deepest first
    for (const dir of dirsDeepestFirst(staging)) chmodSync(dir, 0o555);
    renameSync(staging, target);
    const fd = openSync(this.releases, "r");
    fsyncSync(fd);   // the rename is not the directory's until the directory itself is on disk
    closeSync(fd);
  }

  discard(version: string): void { this.removeTree(this.staging(version)); }

  // A Version a link still points at (§5: current runs it, previous and good are kept for rollback and recovery)
  // is never removed. Anything else — a leftover whose record never made it — is made writable and goes.
  removeVersion(version: string): void {
    const links = this.layout();
    for (const name of ["current", "previous", "good"] as const) {
      if (links[name] === version) {
        throw new Error(`${version}: ${name} points at it; a Version in use is never removed`);
      }
    }
    this.removeTree(join(this.releases, version));
  }

  async verifyTree(version: string, filesSha256: string | null): Promise<TreeFinding[]> {
    const dir = join(this.releases, version);
    const findings: TreeFinding[] = [];
    let listBytes: Buffer;
    try { listBytes = readFileSync(join(dir, "files.json")); } catch { return [{ path: "files.json", problem: "unreadable" }]; }
    if (filesSha256 !== null && this.hashes.sha256(listBytes) !== filesSha256) {
      // the list on disk is not the signed one, so nothing it says can be judged — this, exactly, is the finding
      return [{ path: "files.json", problem: "list_digest" }];
    }
    let list: { path: string; mode: string; sha256: string }[];
    try { list = FileListSchema.parse(JSON.parse(listBytes.toString("utf8"))); }
    catch { return [{ path: "files.json", problem: "unreadable" }]; }
    for (const entry of list) {
      const full = join(dir, entry.path);
      let st: ReturnType<typeof lstatSync>;
      try { st = lstatSync(full); } catch { findings.push({ path: entry.path, problem: "missing" }); continue; }
      if (st.isDirectory()) {
        if (entry.sha256 !== this.hashes.sha256(new Uint8Array(0))) findings.push({ path: entry.path, problem: "changed" });
        else if ((st.mode & 0o777) !== 0o555) findings.push({ path: entry.path, problem: "mode" });
      } else if (st.isSymbolicLink()) {
        // a symlink carries no mode of its own here (lstat always says 0777), so the list's 0555 has nothing to check
        let target: string;
        try { target = readlinkSync(full); } catch { findings.push({ path: entry.path, problem: "unreadable" }); continue; }
        if (this.hashes.sha256(Buffer.from(target)) !== entry.sha256) findings.push({ path: entry.path, problem: "changed" });
      } else {
        let digest: string;
        try { digest = await this.hashes.sha256File(full); } catch { findings.push({ path: entry.path, problem: "unreadable" }); continue; }
        if (digest !== entry.sha256) findings.push({ path: entry.path, problem: "changed" });
        else if ((st.mode & 0o777) !== parseInt(entry.mode, 8)) findings.push({ path: entry.path, problem: "mode" });
      }
    }
    // extra: anything in the tree the list does not name — files.json and install.json aside, and directories
    // that only carry listed paths (morndo doctor reports exactly these)
    const listed = new Set(list.map(e => e.path));
    const walk = (rel: string): void => {
      let dirents: Dirent[];
      try { dirents = readdirSync(join(dir, rel), { withFileTypes: true }); }
      catch { findings.push({ path: rel, problem: "unreadable" }); return; }
      for (const dirent of dirents) {
        const path = rel === "" ? dirent.name : `${rel}/${dirent.name}`;
        if (listed.has(path) || path === "files.json" || path === "install.json") continue;
        if (dirent.isDirectory()) {
          if (list.some(l => l.path.startsWith(`${path}/`))) { walk(path); continue; }
        }
        findings.push({ path, problem: "extra" });
      }
    };
    walk("");
    findings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return findings;
  }

  freeBytes(): number {
    // A machine with nothing installed yet has no releases directory (a checkout, a fresh first check): the file
    // system that would hold it is the nearest one up the tree that exists — the root always does.
    let dir = this.releases;
    for (;;) {
      try {
        const stats = statfsSync(dir);
        return Number(stats.bavail) * Number(stats.bsize);   // blocks an unprivileged user may fill × block size
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = dirname(dir);
        if (parent === dir) throw error;
        dir = parent;
      }
    }
  }

  // Adds the owner's write bit through a tree, so a read-only Version (files 0444, directories 0555) can be
  // removed: deleting a file needs write on its directory, not on the file. Symlinks are skipped — chmod
  // follows a link, and removing one needs its parent's permission only.
  private makeWritable(root: string): void {
    let dirents: Dirent[];
    try { dirents = readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const dirent of dirents) {
      const full = join(root, dirent.name);
      let st: ReturnType<typeof lstatSync>;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isDirectory()) {
        this.makeWritable(full);
        chmodSync(full, st.mode | 0o200);
      } else if (st.isFile()) {
        chmodSync(full, st.mode | 0o200);
      }
    }
    try { chmodSync(root, lstatSync(root).mode | 0o200); } catch { /* already gone */ }
  }

  private removeTree(path: string): void {
    this.makeWritable(path);
    rmSync(path, { recursive: true, force: true });
  }
}

// Every directory under root, deepest first: pre-order reversed, so a parent always follows its children.
function dirsDeepestFirst(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    out.push(dir);
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      if (dirent.isDirectory()) walk(join(dir, dirent.name));
    }
  };
  walk(root);
  return out.reverse();
}
