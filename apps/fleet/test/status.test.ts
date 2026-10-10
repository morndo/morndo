// `morndo-fleet status` and the hook bus: what waits for each configured subscriber, how many dead letters it has, and
// the latest one's time and reason, read from fleet.db, with or without the service running. A real process, a temp
// HOME and config, a fleet.db the test fills.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HookEvent } from "@morndo/protocol";
import type { Subscriber } from "../src/config.ts";
import { Audit } from "../src/adapters/audit.ts";
import { openFleetDb } from "../src/adapters/db.ts";
import { OutboxStore } from "../src/adapters/outbox-store.ts";
import { HookIntake } from "../src/application/hook-intake.ts";
import { createLogger } from "../src/adapters/log.ts";
import { startTestFleet } from "./helpers/fleet.ts";
import { tempDir } from "./helpers/temp.ts";

const MAIN = join(import.meta.dirname, "../src/main.ts");
const ev = (seq: number): HookEvent => ({ streamId: "s1", seq, at: 1_700_000_000_000 + seq, path: "/hook/stop", node: "pc", window: "api", body: {} });

describe("morndo-fleet status", () => {
  it("prints each subscriber's waiting events and dead letters, the latest with its time and reason", () => {
    const home = tempDir();
    const subscribers: Subscriber[] = [
      { name: "kira", url: "http://127.0.0.1:9/hooks", paths: ["/hook/stop"] }, { name: "quiet", url: "http://127.0.0.1:9/q", paths: ["/notify"] },
    ];
    const config = join(home, "fleet.json");
    writeFileSync(config, JSON.stringify({ socketPath: join(home, "s", "f.sock"), subscribers }));
    const db = openFleetDb(join(home, ".local/share/morndo-fleet/fleet.db"));
    const store = new OutboxStore(db);
    new HookIntake({ store, subscribers, audit: new Audit(db) }).accept("pc", "s1", [ev(1), ev(2), ev(3)]);
    const first = store.next("kira", "pc", "s1");
    if (!first) throw new Error("nothing pending for kira");
    store.deadLetter(first, "HTTP 400", 1, Date.UTC(2026, 9, 6, 12));
    db.close();
    const r = spawnSync(process.execPath, ["--no-warnings", MAIN, "status"], { env: { ...process.env, HOME: home, MORNDO_FLEET_CONFIG: config }, encoding: "utf8", timeout: 20_000 });
    expect(r.status).toBe(1);                                                         // no service running
    expect(r.stdout).toMatch(/^hook bus, per subscriber:$/m);
    expect(r.stdout).toMatch(/^ {2}kira\s+2 waiting {2}1 dead letters \(latest 2026-10-06T12:00:00\.000Z: HTTP 400\)$/m);
    expect(r.stdout).toMatch(/^ {2}quiet\s+0 waiting {2}0 dead letters$/m);
    expect(r.stdout).toMatch(/^hook events no subscriber takes: none$/m);
  });

  it("prints, per path, the hook events no subscriber takes, counted and never delivered (final review I3)", () => {
    const home = tempDir();
    const subscribers: Subscriber[] = [{ name: "kira", url: "http://127.0.0.1:9/hooks", paths: ["/hook/stop"] }];
    const config = join(home, "fleet.json");
    writeFileSync(config, JSON.stringify({ socketPath: join(home, "s", "f.sock"), subscribers }));
    const db = openFleetDb(join(home, ".local/share/morndo-fleet/fleet.db"));
    const at = (seq: number, path: HookEvent["path"]): HookEvent => ({ ...ev(seq), path });
    const intake = new HookIntake({ store: new OutboxStore(db), subscribers, audit: new Audit(db), now: () => Date.UTC(2026, 9, 6, 12) });
    intake.accept("pc", "s1", [at(1, "/notify"), at(2, "/cc"), at(3, "/hook/stop"), at(4, "/notify")]);
    db.close();
    const r = spawnSync(process.execPath, ["--no-warnings", MAIN, "status"], { env: { ...process.env, HOME: home, MORNDO_FLEET_CONFIG: config }, encoding: "utf8", timeout: 20_000 });
    expect(r.stdout).toMatch(/^hook events no subscriber takes \(acknowledged and counted, never delivered\):$/m);
    expect(r.stdout).toMatch(/^ {2}\/cc\s+1 {2}\(latest 2026-10-06T12:00:00\.000Z\)$/m);
    expect(r.stdout).toMatch(/^ {2}\/notify\s+2 {2}\(latest 2026-10-06T12:00:00\.000Z\)$/m);
    expect(r.stdout).not.toMatch(/^ {2}\/hook\/stop\s+\d/m);                            // kira takes it
    expect(r.stdout).toMatch(/alert\.unrouted_hook\s+pc\s+\{"path":"\/notify","events":2\}/);
  });

  it("serve logs, once at startup, each script path no subscriber takes; progress paths and subscribed ones are not named", async () => {
    const lines: string[] = [];
    await startTestFleet({ log: createLogger({ level: "debug", sink: l => { lines.push(l); } }), config: { subscribers: [{ name: "kira", url: "http://127.0.0.1:9/h", paths: ["/hook/stop", "/cc"] }] } });
    const named = lines.filter(l => l.includes("no subscriber takes")).map(l => /takes (\S+?):/.exec(l)?.[1]);
    expect(named).toEqual(["/hook/failure", "/notify", "/file"]);
  });
});
