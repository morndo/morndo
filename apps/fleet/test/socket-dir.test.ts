// The client API's socket (spec 5.6, 8): the service refuses to start unless the socket's directory is a real
// directory owned by this user with mode 0700; a stale socket is cleared, a live one is never taken over, and
// anything else at the path is left alone.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SocketDirUnsafe, SocketInUse, clearStaleSocket, prepareSocketDir } from "../src/adapters/socket-dir.ts";
import { startTestFleet } from "./helpers/fleet.ts";
import { client } from "./helpers/socket-client.ts";
import { tempDir } from "./helpers/temp.ts";

describe("the socket directory", () => {
  it("is created with mode 0700 when missing; the socket is 0600 and answers", async () => {
    const fleet = await startTestFleet();
    expect(statSync(join(fleet.dir, "s")).mode & 0o777).toBe(0o700);
    expect(statSync(fleet.config.socketPath).mode & 0o777).toBe(0o600);
    expect(await client(fleet.config.socketPath).get("/v1/caps")).toEqual({ status: 200, body: { api: [1], stickyLanes: ["manager"] } });
  });

  it("a directory others can enter stops the service before it opens anything", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "s"), { mode: 0o755 });
    chmodSync(join(dir, "s"), 0o755);
    await expect(startTestFleet({ dir })).rejects.toThrow(SocketDirUnsafe);
    await expect(startTestFleet({ dir })).rejects.toThrow(/mode 700, not 755/);
    expect(existsSync(join(dir, "s", "f.sock"))).toBe(false);
    expect(existsSync(join(dir, "fleet.db"))).toBe(false);                          // refused before the database
  });

  it("`morndo-fleet serve` exits 78 (EX_CONFIG) with one sentence, not a crash to restart into", () => {
    const home = tempDir();
    mkdirSync(join(home, "open"), { mode: 0o755 });
    chmodSync(join(home, "open"), 0o755);
    const config = join(home, "fleet.json");
    writeFileSync(config, JSON.stringify({ listen: { host: "127.0.0.1", port: 0 }, socketPath: join(home, "open", "f.sock") }));
    const main = join(import.meta.dirname, "../src/main.ts");
    const r = spawnSync(process.execPath, ["--no-warnings", main, "serve"], { env: { ...process.env, HOME: home, MORNDO_FLEET_CONFIG: config }, encoding: "utf8", timeout: 20_000 });
    expect(r.status).toBe(78);
    expect(r.stderr).toMatch(/must have mode 700, not 755/);
    expect(r.stderr).not.toMatch(/\n\s+at /);                                        // a sentence, not a stack trace
  });

  it("refuses a symlinked directory and another user's directory", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "real"), { mode: 0o700 });
    symlinkSync(join(dir, "real"), join(dir, "link"));
    expect(() => prepareSocketDir(join(dir, "link", "f.sock"))).toThrow(/must be a directory/);
    const uid = process.getuid?.() ?? 0;
    expect(() => prepareSocketDir(join(dir, "real", "f.sock"), uid + 1)).toThrow(/must belong to this user/);
    expect(() => prepareSocketDir(join(dir, "real", "f.sock"), uid)).not.toThrow();
  });

  it("clears a stale socket, refuses a live one, and never deletes a file that isn't a socket", async () => {
    const dir = tempDir();
    const path = join(dir, "x.sock");
    const live = createServer();
    await new Promise<void>(r => live.listen(path, r));
    await expect(clearStaleSocket(path)).rejects.toThrow(SocketInUse);
    await new Promise<void>(r => { live.close(() => r()); });
    // A service killed outright leaves its socket file behind, with nobody listening.
    const killed = spawnSync(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, "SIGKILL"))`]);
    expect(killed.signal).toBe("SIGKILL");
    expect(statSync(path).isSocket()).toBe(true);
    await clearStaleSocket(path);
    expect(existsSync(path)).toBe(false);
    const file = join(dir, "not-a-socket");
    writeFileSync(file, "keep me");
    await expect(clearStaleSocket(file)).rejects.toThrow(/is not a socket/);
    expect(readFileSync(file, "utf8")).toBe("keep me");
  });

  it("a second service on the same socket refuses to start, and the first keeps serving", async () => {
    const first = await startTestFleet();
    await expect(startTestFleet({ dir: first.dir, config: { dbPath: join(first.dir, "other.db") } })).rejects.toThrow(SocketInUse);
    expect((await client(first.config.socketPath).get("/v1/caps"))?.status).toBe(200);
  });

  it("a second service on the same socket and database stops before it touches the database: no prune, no lane cleanup", async () => {
    const first = await startTestFleet();
    first.db.prepare("INSERT INTO audit (at, actor, action, node, detail) VALUES (1, 'test', 'old.row', NULL, '{}')").run();
    first.db.prepare("INSERT INTO lanes (name, node, worker_id, registered_at, conflict) VALUES ('ghost', 'unknown-node', NULL, 1, 0)").run();
    await expect(startTestFleet({ dir: first.dir })).rejects.toThrow(SocketInUse);   // the same socket, database and key
    expect(first.audit.of("old.row")).toHaveLength(1);                               // a start would prune it (older than 90 days)
    expect(first.db.prepare("SELECT name FROM lanes").all()).toEqual([{ name: "ghost" }]);   // and drop lanes of unregistered nodes
  });
});
