// transcript.* through the session registry, file.stat/get under today's confinement rules, and file.put's staging
// (spec §3.1, §5.3, §8), on a temporary HOME with a throwaway ~/.claude.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localTranscriptBytes } from "@morndo/node-ops";
import { LIMITS } from "@morndo/protocol";
import { isolatedTmux, tempHome, type TestTmux } from "./helpers.ts";
import { opsHarness, type Harness } from "./ops-harness.ts";

const SID = "3f0c1d2e-1111-4222-8333-444455556666";
let home: { home: string; cleanup: () => void };
let t: TestTmux;
let h: Harness;
let transcript = "";
beforeEach(() => {
  home = tempHome();
  t = isolatedTmux();
  const claude = join(home.home, ".claude");
  mkdirSync(join(claude, "sessions"), { recursive: true });
  mkdirSync(join(claude, "projects", "-work"), { recursive: true });
  writeFileSync(join(claude, "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: SID, tmux: "main:@0.%0", cwd: "/work", version: "2.1.286" }));
  transcript = join(claude, "projects", "-work", `${SID}.jsonl`);
  const lines = Array.from({ length: 40 }, (_, i) => JSON.stringify({ type: "user", uuid: `u-${i}`, message: { content: i === 30 ? "the needle is here" : `line ${i} ${"ü".repeat(i)}` } }));
  writeFileSync(transcript, `${lines.join("\n")}\n`);
  h = opsHarness({ home: home.home, socket: t.socket });
});
afterEach(() => { h.close(); t.kill(); home.cleanup(); });

const bytesOf = (r: { ok: boolean; result?: unknown }) => Buffer.from(((r as { result: { bytes: string } }).result).bytes, "base64");

describe("transcript.*", () => {
  it("reads a session's transcript by id, in chunks that reassemble to the file's bytes", async () => {
    const size = statSync(transcript).size;
    expect(await h.call("transcript.size", { sessionId: SID })).toMatchObject({ ok: true, result: { size } });
    const parts: Buffer[] = [];
    for (let offset = 0, eof = false; !eof;) {
      const r = await h.call("transcript.read", { sessionId: SID, offset, max: 333 });
      if (!r.ok) throw new Error(r.error.message);
      const b = bytesOf(r);
      parts.push(b);
      offset += b.length;
      eof = (r.result as { eof: boolean }).eof;
    }
    expect(Buffer.concat(parts).equals(readFileSync(transcript))).toBe(true);
    const expected = await localTranscriptBytes(transcript).locate("the needle");
    expect(expected).not.toBeNull();
    expect(await h.call("transcript.locate", { sessionId: SID, needle: "the needle" })).toMatchObject({ ok: true, result: { offset: expected } });
  });
  it("answers null or bad_args for a session it doesn't have, and refuses ids that could be paths", async () => {
    const other = "00000000-0000-4000-8000-000000000000";
    expect(await h.call("transcript.size", { sessionId: other })).toMatchObject({ ok: true, result: { size: null } });
    expect(await h.call("transcript.read", { sessionId: other, offset: 0, max: 10 })).toMatchObject({ ok: false, error: { code: "bad_args" } });
    expect(await h.call("transcript.locate", { sessionId: other, needle: "x" })).toMatchObject({ ok: true, result: { offset: null } });
    for (const sessionId of ["../../etc/passwd", "a/b", "x.jsonl"]) {
      expect(await h.call("transcript.size", { sessionId })).toMatchObject({ ok: false, error: { code: "bad_args" } });
    }
    expect(await h.call("transcript.read", { sessionId: SID, offset: 0, max: LIMITS.chunkBytes + 1 })).toMatchObject({ ok: false, error: { code: "bad_args" } });
  });
});

describe("file.stat and file.get", () => {
  it("serves a plain file in 256 KiB chunks", async () => {
    const work = join(home.home, "work");
    mkdirSync(work);
    const data = randomBytes(600 * 1024);
    writeFileSync(join(work, "shot.png"), data);
    expect(await h.call("file.stat", { path: join(work, "shot.png") })).toMatchObject({ ok: true, result: { size: data.length, mtime: statSync(join(work, "shot.png")).mtimeMs } });
    const parts: Buffer[] = [];
    for (let offset = 0, eof = false; !eof;) {
      const r = await h.call("file.get", { path: join(work, "shot.png"), offset, max: LIMITS.chunkBytes });
      if (!r.ok) throw new Error(r.error.message);
      const b = bytesOf(r);
      expect(b.length).toBeLessThanOrEqual(LIMITS.chunkBytes);
      parts.push(b);
      offset += b.length;
      eof = (r.result as { eof: boolean }).eof;
    }
    expect(Buffer.concat(parts).equals(data)).toBe(true);
  });
  it("refuses credentials, secrets by name, the agent's own key and database, directories, big and missing files", async () => {
    const work = join(home.home, "work");
    mkdirSync(join(home.home, ".ssh"), { recursive: true });
    mkdirSync(work, { recursive: true });
    mkdirSync(h.paths.configDir, { recursive: true });
    writeFileSync(join(home.home, ".ssh", "id_ed25519"), "key");
    writeFileSync(join(work, ".env"), "TOKEN=x");
    writeFileSync(h.paths.keyPath, "-----BEGIN PRIVATE KEY-----");
    writeFileSync(join(work, "big.bin"), "");
    truncateSync(join(work, "big.bin"), LIMITS.maxFileBytes + 1);
    const cases: [string, string][] = [
      [join(home.home, ".ssh", "id_ed25519"), "denied"],
      [join(work, ".env"), "denied"],
      [h.paths.keyPath, "denied"],
      [h.paths.dbPath, "denied"],
      [work, "denied"],
      [join(work, "big.bin"), "too_large"],
      [join(work, "missing.txt"), "bad_args"],
    ];
    for (const [path, code] of cases) {
      expect(await h.call("file.get", { path, offset: 0, max: 10 }), path).toMatchObject({ ok: false, error: { code, executed: "no" } });
    }
    expect(await h.call("file.get", { path: "relative.txt", offset: 0, max: 10 })).toMatchObject({ ok: false, error: { code: "bad_args" } });
    writeFileSync(join(work, "ok.txt"), "fine");
    expect(await h.call("file.get", { path: join(work, "ok.txt"), offset: 0, max: 10 })).toMatchObject({ ok: true, result: { size: 4, eof: true } });   // negative control
  });
  it("never shares the control plane's own state, kira's, or an account's credentials (node-ops' deny list), also through a link", async () => {
    const secret = [
      [".local", "share", "morndo", "morndo.db"], [".local", "share", "morndo-fleet", "fleet.db"], [".local", "state", "morndo-fleet", "notes.txt"],
      [".local", "share", "kira", "state.json"], [".config", "kira", "config.json"], [".config", "morndo-fleet", "config.json"],
      [".config", "morndo-node", "policy.json"], [".claude-accounts", "acct2", ".credentials.json"], [".claude", ".credentials.json"],
    ].map(p => join(home.home, ...p));
    for (const f of secret) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, "kept here"); }
    const work = join(home.home, "work");
    mkdirSync(work, { recursive: true });
    symlinkSync(secret[0] as string, join(work, "innocent.txt"));
    for (const path of [...secret, join(work, "innocent.txt")]) {
      expect(await h.call("file.get", { path, offset: 0, max: 10 }), path).toMatchObject({ ok: false, error: { code: "denied", executed: "no" } });
      expect(await h.call("file.stat", { path }), path).toMatchObject({ ok: false, error: { code: "denied", executed: "no" } });
    }
    writeFileSync(join(home.home, ".local", "share", "notes.txt"), "beside them");      // negative control: not every file there
    expect(await h.call("file.get", { path: join(home.home, ".local", "share", "notes.txt"), offset: 0, max: 20 })).toMatchObject({ ok: true, result: { size: 11 } });
  });
  it("serves a hook relay copy by its ref, and only by a ref it holds", async () => {
    mkdirSync(h.paths.relayFilesDir, { recursive: true });
    const ref = "ab".repeat(16);
    writeFileSync(join(h.paths.relayFilesDir, ref), "relayed");
    h.adb.db.prepare("INSERT INTO relay_files (ref, file, name, size, at, seq) VALUES (?, ?, 'note.txt', 7, 1, 1)").run(ref, join(h.paths.relayFilesDir, ref));
    expect(await h.call("file.get", { ref, offset: 0, max: 100 })).toMatchObject({ ok: true, result: { bytes: Buffer.from("relayed").toString("base64"), size: 7, eof: true } });
    expect(await h.call("file.stat", { ref: "cd".repeat(16) })).toMatchObject({ ok: false, error: { code: "bad_args" } });
    expect(await h.call("file.stat", { ref, path: "/etc/hosts" })).toMatchObject({ ok: false, error: { code: "bad_args" } });
  });
});

describe("file.put", () => {
  const chunk = (upload: string, offset: number, bytes: Buffer, final: boolean, name = "photo.png") =>
    ({ upload, offset, bytes: bytes.toString("base64"), final, name });

  it("stages chunks in order and moves the upload into the inbox on the final one; a repeated chunk key appends nothing", async () => {
    const a = randomBytes(1000), b = randomBytes(500);
    expect(await h.call("file.put", chunk("upload-0001", 0, a, false), { key: "hub:up1:0" })).toMatchObject({ ok: true, result: { path: null } });
    expect(await h.call("file.put", chunk("upload-0001", 0, a, false), { key: "hub:up1:0" })).toMatchObject({ ok: true, result: { path: null } });
    expect(await h.call("file.put", chunk("upload-0001", 1000, b, true, "../Photo 1.png"), { key: "hub:up1:1000" }))
      .toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });             // a name with "/": OP_ARGS refuses it, as the fleet does
    const done = await h.call("file.put", chunk("upload-0001", 1000, b, true, ".Photo 1.png"), { key: "hub:up1:1000" });
    if (!done.ok) throw new Error(done.error.message);
    const path = (done.result as { path: string }).path;
    expect(path).toBe(join(h.paths.inboxDir, "upload-0001-Photo_1.png"));                   // a safe name: no leading dot, no space
    expect(readFileSync(path).equals(Buffer.concat([a, b]))).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  it("refuses a chunk out of order, and an upload over 25 MiB", async () => {
    expect(await h.call("file.put", chunk("upload-0002", 10, randomBytes(5), false), { key: "hub:up2" })).toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });
    mkdirSync(join(h.paths.inboxDir, ".partial"), { recursive: true });
    const partial = join(h.paths.inboxDir, ".partial", "upload-0003");
    writeFileSync(partial, "");
    truncateSync(partial, LIMITS.maxFileBytes);
    expect(await h.call("file.put", chunk("upload-0003", LIMITS.maxFileBytes, randomBytes(1), true), { key: "hub:up3" })).toMatchObject({ ok: false, error: { code: "too_large", executed: "no" } });
    expect(h.doneKeys.status("hub:up3")).toEqual({ state: "unknown" });
  });
  it("refuses a chunk the node's disk budget can't hold (too_large, not executed), and frees the key", async () => {
    h.close();
    h = opsHarness({ home: home.home, socket: t.socket, room: () => 1000 - h.inbox.bytes() });   // 1000 bytes, less what the inbox holds
    expect(await h.call("file.put", chunk("upload-0005", 0, randomBytes(800), false), { key: "hub:up5:0" })).toMatchObject({ ok: true, result: { path: null } });
    expect(h.inbox.bytes()).toBe(800);
    expect(await h.call("file.put", chunk("upload-0005", 800, randomBytes(300), true), { key: "hub:up5:800" }))
      .toMatchObject({ ok: false, error: { code: "too_large", executed: "no", message: expect.stringMatching(/disk budget/) } });
    expect(h.doneKeys.status("hub:up5:800")).toEqual({ state: "unknown" });
    expect(await h.call("file.put", chunk("upload-0005", 800, randomBytes(150), true), { key: "hub:up5:800" })).toMatchObject({ ok: true });   // what fits
  });
  it("forgets a partial upload untouched for 10 minutes", async () => {
    await h.call("file.put", chunk("upload-0004", 0, randomBytes(10), false), { key: "hub:up4:0" });
    const partial = join(h.paths.inboxDir, ".partial", "upload-0004");
    const old = (Date.now() - 11 * 60_000) / 1000;
    utimesSync(partial, old, old);
    expect(await h.call("file.put", chunk("upload-0004", 10, randomBytes(10), true), { key: "hub:up4:10" })).toMatchObject({ ok: false, error: { code: "bad_args", message: expect.stringMatching(/expired/) } });
  });
});
