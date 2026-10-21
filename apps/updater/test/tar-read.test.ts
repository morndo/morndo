// The tar reader's contract (design §6.1 step 4, §10.4 "a crafted archive"): it reads exactly what
// scripts/release/archive.ts packTree writes and refuses everything else — paths that leave the tree, links that
// point out (straight or through another link of the archive), anything written through a link, device nodes and
// GNU extensions, a bad checksum, a truncated body,
// unbounded expansion. Every refusal also checks that nothing landed outside dest: the reader's one write rule.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packTree, type TreeFile } from "../../../scripts/release/archive.ts";
import { extractTar, TarRefused, type TarEntry } from "../src/adapters/tar-read.ts";
import { evilGz, paxBody, rawTar } from "./helpers/tar-fixtures.ts";

let root = "";

beforeAll(() => { root = mkdtempSync(join(tmpdir(), "morndo-upd-")); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

const dir = (name: string) => join(root, name);

// One refusal case: TarRefused with a reason, and dest's parent holding exactly what it held before — an escape
// (`../x`, `a/../../b`) would create a sibling of dest, so the listing is the check.
const refuse = async (gz: Buffer, name: string, reason: RegExp, o: { maxBytes?: number } = {}): Promise<void> => {
  const archive = dir(`${name}.tar.gz`);
  const dest = dir(`${name}-dest`);
  writeFileSync(archive, gz);
  mkdirSync(dest);
  const before = readdirSync(root).sort();
  let thrown: unknown;
  try { await extractTar(archive, dest, { maxBytes: o.maxBytes ?? 10 * 1024 * 1024 }); }
  catch (error) { thrown = error; }
  expect(thrown, name).toBeInstanceOf(TarRefused);
  expect((thrown as TarRefused).reason, name).toMatch(reason);
  expect(readdirSync(root).sort(), name).toEqual(before);
};

const MODE = (path: string) => (statSync(path).mode & 0o777).toString(8);

// One 152-character name with no "/" in it: no ustar prefix/name split can hold it, so packTree writes it as a
// pax `path` record — the one extension the reader accepts.
const LONG = `${"leaf".repeat(37)}.txt`;

const GOOD: TreeFile[] = [
  { path: "README.md", mode: "0444", bytes: Buffer.from("morndo 0.2.0\n") },
  { path: "app/lib/main.js", mode: "0444", bytes: Buffer.from("console.log('hi')\n") },
  { path: "app/run.sh", mode: "0555", bytes: Buffer.from("#!/bin/sh\necho 0.2.0\n") },
  { path: "bin/morndo", mode: "0555", link: "../app/run.sh" },
  { path: "units", mode: "0555", directory: true },
  { path: "units/hub.service", mode: "0444", bytes: Buffer.from("[Unit]\n") },
  { path: LONG, mode: "0444", bytes: Buffer.from("a long name\n") },
];

describe("extractTar", () => {
  it("extracts a packTree archive exactly: entries in archive order, contents, link targets, its own modes", async () => {
    const archive = dir("good.tar.gz");
    writeFileSync(archive, packTree(GOOD, 0));
    const dest = dir("good-dest");
    mkdirSync(dest);
    const entries = await extractTar(archive, dest, { maxBytes: 10 * 1024 * 1024 });
    const byPath = new Map(entries.map((e: TarEntry) => [e.path, e]));
    // every file of the tree, plus packTree's explicit directories and the implicit parents of nested paths
    expect([...byPath.keys()].sort()).toEqual([...GOOD.map(f => f.path), "app", "app/lib", "bin"].sort());
    expect(byPath.get("units")!.type).toBe("dir");
    expect(byPath.get("app/lib/main.js")!.type).toBe("file");
    expect(byPath.get("bin/morndo")).toEqual({ path: "bin/morndo", type: "symlink", link: "../app/run.sh" });
    expect(byPath.get(LONG)!.type).toBe("file");
    // the disk agrees: contents, link targets, and the reader's own modes (the signed list sets the final ones)
    expect(readFileSync(join(dest, "README.md"), "utf8")).toBe("morndo 0.2.0\n");
    expect(readFileSync(join(dest, LONG), "utf8")).toBe("a long name\n");
    expect(readlinkSync(join(dest, "bin/morndo"))).toBe("../app/run.sh");
    expect(statSync(join(dest, "units")).isDirectory()).toBe(true);
    expect(MODE(join(dest, "README.md"))).toBe("600");
    expect(MODE(join(dest, "app"))).toBe("700");
  });

  it("refuses a '..' escape (../escape)", () => refuse(evilGz([{ name: "../escape", body: Buffer.from("out") }]), "escape", /escape/));
  it("refuses an absolute path (/abs)", () => refuse(evilGz([{ name: "/abs", body: Buffer.from("out") }]), "abs", /\/abs/));
  it("refuses a climb back out (a/../../b)", () => refuse(evilGz([{ name: "a/../../b", body: Buffer.from("out") }]), "climb", /a\/\.\.\/\.\.\/b/));
  it("refuses a link that leaves the tree (l -> ../../out)", () => refuse(evilGz([{ name: "l", type: "2", link: "../../out" }]), "link-out", /l|\.\.\/\.\.\/out/));
  it("refuses an absolute link target (l -> /etc)", () => refuse(evilGz([{ name: "l", type: "2", link: "/etc" }]), "link-abs", /\/etc/));
  // "x/l1/.." passes the lexical rule on its own, but x/l1 is itself a link: walking dest/l2 — the kernel, e.g.
  // chdir(2) through it — lands on the parent of dest, so the reader resolves each target through the archive's
  // own links before any of them can be walked.
  it("refuses a link that climbs out through another link (x/l1 -> .., l2 -> x/l1/..)", () =>
    refuse(evilGz([
      { name: "x", type: "5" },
      { name: "x/l1", type: "2", link: ".." },
      { name: "l2", type: "2", link: "x/l1/.." },
    ]), "link-through-link", /l2/));
  it("accepts a link chain that stays inside (x/l1 -> .., l3 -> x/l1/x)", async () => {
    const archive = dir("chain.tar.gz");
    writeFileSync(archive, evilGz([
      { name: "x", type: "5" },
      { name: "x/l1", type: "2", link: ".." },
      { name: "l3", type: "2", link: "x/l1/x" },
    ]));
    const dest = dir("chain-dest");
    mkdirSync(dest);
    const entries = await extractTar(archive, dest, { maxBytes: 10 * 1024 * 1024 });
    expect(entries.filter(e => e.type === "symlink").map(e => e.path).sort()).toEqual(["l3", "x/l1"]);
    // the kernel agrees the chain stays inside: walking l3 lands on x, not on anything past dest
    expect(realpathSync(join(dest, "l3"))).toBe(realpathSync(join(dest, "x")));
  });
  it("refuses a link loop (a -> b, b -> a, c -> a/z)", () =>
    refuse(evilGz([
      { name: "a", type: "2", link: "b" },
      { name: "b", type: "2", link: "a" },
      { name: "c", type: "2", link: "a/z" },
    ]), "link-loop", /loop/));
  it("refuses a file written through a symlink (l -> d, then l/x)", () =>
    refuse(evilGz([{ name: "l", type: "2", link: "d" }, { name: "l/x", body: Buffer.from("pwn") }]), "through-link", /l/));

  it("refuses a hard link, naming its typeflag", () => refuse(evilGz([{ name: "b", type: "1", link: "a" }]), "hardlink", /'1'/));
  it("refuses a character device, naming its typeflag", () => refuse(evilGz([{ name: "dev", type: "3" }]), "chardev", /'3'/));
  it("refuses a block device, naming its typeflag", () => refuse(evilGz([{ name: "dev", type: "4" }]), "blockdev", /'4'/));
  it("refuses a FIFO, naming its typeflag", () => refuse(evilGz([{ name: "pipe", type: "6" }]), "fifo", /'6'/));
  it("refuses a GNU long name (typeflag L)", () => refuse(evilGz([{ name: "@LongLink", type: "L", body: Buffer.from("nnnnnnnnnnnnnnnnnnnn") }]), "gnu-l", /'L'/));

  it("refuses a pax key other than path and linkpath", () =>
    refuse(evilGz([{ name: "PaxHeaders/1", type: "x", body: paxBody([["comment", "trust me"]]) }, { name: "a", body: Buffer.from("x") }]), "pax-key", /comment/));

  it("refuses a path seen twice", () =>
    refuse(evilGz([{ name: "a", body: Buffer.from("1") }, { name: "a", body: Buffer.from("2") }]), "duplicate", /duplicate.*a|a.*duplicate/));

  it("refuses a bad header checksum", () =>
    refuse(evilGz([{ name: "a", body: Buffer.from("x"), badChecksum: true }]), "checksum", /checksum/));

  it("refuses a truncated archive (the stream ends inside a body)", () => {
    // the gzip is whole, so gunzip ends cleanly; the tar inside stops mid-body (512-byte header, then 600 of 1000)
    const cut = rawTar([{ name: "a", body: Buffer.alloc(1000, 0x61) }]).subarray(0, 512 + 600);
    return refuse(gzipSync(cut), "truncated", /truncat/);
  });

  it("refuses a body past maxBytes", async () => {
    const archive = dir("toolarge.tar.gz");
    writeFileSync(archive, packTree(GOOD, 0));
    const dest = dir("toolarge-dest");
    mkdirSync(dest);
    await expect(extractTar(archive, dest, { maxBytes: 512 })).rejects.toMatchObject({ reason: /too large/ });
  });
});
