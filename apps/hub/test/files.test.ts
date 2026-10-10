// The hub's file copies: what is kept, what is refused, and how a copy is served. Copies are made in the background
// (fleet core §3.1): register() answers once its copy has landed.
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { denyRoots } from "@morndo/node-ops";
import { fileStore, servingHeaders, storedIds } from "../src/adapters/files.ts";

let root: string, home: string, data: string, work: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "morndo-files-"));
  home = join(root, "home"); data = join(root, "data"); work = join(root, "work");
  for (const d of [home, join(home, ".ssh"), data, work]) mkdirSync(d, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const store = (o: { maxBytes?: number; budgetBytes?: number } = {}) => fileStore({ dir: join(data, "files"), deny: denyRoots(home, data), ...o });

describe("keeping copies", () => {
  it("keeps one content-addressed copy, still served after the original is gone", async () => {
    writeFileSync(join(work, "a.png"), "png-bytes");
    writeFileSync(join(work, "same.png"), "png-bytes");
    const s = store();
    const a = await s.register(join(work, "a.png"));
    expect(a.id).toMatch(/^[0-9a-f]{32}$/);
    expect((await s.register(join(work, "same.png"))).id).toBe(a.id);      // same bytes, one copy
    expect(storedIds(join(data, "files"))).toEqual([a.id]);
    unlinkSync(join(work, "a.png"));
    expect((await store().register(join(work, "a.png"))).id).toBe(a.id);    // after a restart, from the index
    expect(store().get(a.id ?? "")?.meta).toMatchObject({ name: "a.png", mime: "image/png", kind: "image", size: 9 });
  });
  it("copies in the background: register answers a promise, and the event loop goes on while a big file copies", async () => {
    writeFileSync(join(work, "big.bin"), Buffer.alloc(8 << 20, 1));
    const copying = store().register(join(work, "big.bin"));
    expect(copying).toBeInstanceOf(Promise);
    let ticked = false;
    setImmediate(() => { ticked = true; });
    expect((await copying).id).toMatch(/^[0-9a-f]{32}$/);
    expect(ticked).toBe(true);                                             // the loop ran while the copy was made
  });
  it("one path registered twice at once: one copy, both get it, and no temporary file is left", async () => {
    writeFileSync(join(work, "big.bin"), Buffer.alloc(4 << 20, 7));
    const s = store();
    const [one, two] = await Promise.all([s.register(join(work, "big.bin")), s.register(join(work, "big.bin"))]);
    expect(one.id).toMatch(/^[0-9a-f]{32}$/);
    expect(two).toEqual(one);
    expect(one.size).toBe(4 << 20);
    expect(readdirSync(join(data, "files")).filter(f => f !== "index.json")).toEqual([one.id]);
  });
  it("refuses credentials, the hub's own data, secrets by name, links into them, directories and big files", async () => {
    writeFileSync(join(home, ".ssh", "id_ed25519"), "key");
    writeFileSync(join(work, ".env"), "TOKEN=x");
    writeFileSync(join(work, "server.pem"), "pem");
    writeFileSync(join(data, "morndo.db"), "db");
    symlinkSync(join(home, ".ssh", "id_ed25519"), join(work, "innocent.png"));
    writeFileSync(join(work, "big.bin"), Buffer.alloc(2048));
    const s = store({ maxBytes: 1024 });
    for (const p of [join(home, ".ssh", "id_ed25519"), join(work, ".env"), join(work, "server.pem"), join(data, "morndo.db"), join(work, "innocent.png"), work, join(work, "big.bin"), join(work, "missing.png")]) {
      expect((await s.register(p)).id, p).toBeNull();
    }
    expect(storedIds(join(data, "files"))).toEqual([]);
    writeFileSync(join(work, "ok.txt"), "fine");
    expect((await s.register(join(work, "ok.txt"))).id).not.toBeNull();     // negative control: a plain file is kept
  });
  it("refuses the fleet's, the agents' and kira's state and each account's credentials, as a node does (node-ops' deny list)", async () => {
    const at = (rel: string) => { const p = join(home, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, "x"); return p; };
    const s = store();
    for (const rel of [".local/share/morndo-fleet/fleet.db", ".local/state/morndo-node/agent.db", ".config/morndo-node/policy.json", ".local/share/kira/state.json",
      ".claude-accounts/acct2/.credentials.json"]) {
      expect((await s.register(at(rel))).id, rel).toBeNull();
    }
    expect((await s.register(at(".local/share/other/ok.txt"))).id).not.toBeNull();   // negative control: a neighbour of theirs is kept
  });
  // The residual round (final review M10's twin in the hub): a real path never runs through a symbolic link, so deny
  // roots made from a HOME behind one must be resolved before they are compared with it, or nothing under them is caught
  // by its real path. The temporary root is resolved first, so the HOME link is the only one in play.
  it("refuses what lies under a deny root of a HOME behind a symbolic link, by the real path and through a link", async () => {
    const base = realpathSync(root);
    const realHome = join(base, "real-home");
    const linkHome = join(base, "home-link");
    for (const d of [join(realHome, ".ssh"), join(realHome, ".aws")]) mkdirSync(d, { recursive: true });
    symlinkSync(realHome, linkHome);
    writeFileSync(join(realHome, ".ssh", "config"), "Host *");               // no secret's name: only the deny root refuses it
    writeFileSync(join(realHome, ".aws", "config"), "[default]");
    symlinkSync(join(linkHome, ".aws", "config"), join(work, "notes.txt"));
    const s = fileStore({ dir: join(data, "files"), deny: denyRoots(linkHome, data) });
    for (const p of [join(realHome, ".ssh", "config"), join(work, "notes.txt")]) expect((await s.register(p)).id, p).toBeNull();
    writeFileSync(join(realHome, "ok.txt"), "fine");
    expect((await s.register(join(realHome, "ok.txt"))).id).not.toBeNull();   // negative control: the home's own files are kept
  });
  it("drops the oldest copies once over its budget", async () => {
    const s = store({ budgetBytes: 10 });
    writeFileSync(join(work, "one.txt"), "123456");
    const one = (await s.register(join(work, "one.txt"))).id;
    writeFileSync(join(work, "two.txt"), "abcdef");
    const two = (await s.register(join(work, "two.txt"))).id;
    expect(s.get(one ?? "")).toBeNull();
    expect(s.get(two ?? "")).not.toBeNull();
  });
  it("serves only ids it holds", () => {
    expect(store().get("../../etc/passwd")).toBeNull();
    expect(store().get("0".repeat(32))).toBeNull();
  });
});

describe("serving", () => {
  const meta = (kind: "image" | "pdf" | "text" | "file", mime: string) => ({ id: "x", name: "ä b.svg", mime, kind, size: 3 });
  it("never as a page of the hub: sandboxed, nosniff, text as text/plain; PDFs viewable but allowed nothing", () => {
    const svg = servingHeaders(meta("image", "image/svg+xml"), false);
    expect(svg["Content-Security-Policy"]).toMatch(/sandbox$/);
    expect(svg["X-Content-Type-Options"]).toBe("nosniff");
    expect(svg["Content-Disposition"]).toBe("inline; filename*=UTF-8''%C3%A4%20b.svg");
    expect(servingHeaders(meta("pdf", "application/pdf"), false)["Content-Security-Policy"]).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    expect(servingHeaders(meta("file", "application/octet-stream"), false)["Content-Disposition"]).toMatch(/^attachment/);
    expect(servingHeaders(meta("image", "image/png"), true)["Content-Disposition"]).toMatch(/^attachment/);
  });
});
