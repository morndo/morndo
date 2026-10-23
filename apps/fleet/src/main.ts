#!/usr/bin/env node
// morndo-fleet: the fleet service (ADR-0012). `node add|list|revoke` and `status` are its console; they open fleet.db
// themselves (better-sqlite3 waits on the service's locks) and reach the running service through its Unix socket.
import type Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { LIMITS, NODE_NAME, formatJoinString, isNodeName } from "@morndo/protocol";
import { NotLocalDisk, RevocationJournal, assertLocalDisk, exitAfterOutput, buildLabel, quietBrokenPipe } from "@morndo/service-kit";
import { ConfigError, loadConfig, type FleetConfig } from "./config.ts";
import { DatabaseUnreadable, openFleetDb } from "./adapters/db.ts";
import { DatabaseFromFuture } from "./adapters/migrations.ts";
import { KeyFileUnsafe, loadOrCreateFleetKey, type FleetKey } from "./adapters/keys.ts";
import { NodesStore } from "./adapters/nodes-store.ts";
import { OutboxStore } from "./adapters/outbox-store.ts";
import { Audit } from "./adapters/audit.ts";
import { socketRequest } from "./adapters/socket-request.ts";
import { SocketDirUnsafe, SocketInUse } from "./adapters/socket-dir.ts";
import { exitOnCrash } from "./adapters/crash.ts";
import { log } from "./adapters/log.ts";
import { startFleet } from "./serve.ts";

const HELP = `morndo-fleet: the fleet service. Nodes dial in; the hub, kira and lanes talk to it over a Unix socket.

  morndo-fleet serve                run the service: agents on 127.0.0.1:8791/agent, clients on the socket
  morndo-fleet node add <name>      a one-time join string for a new node (valid 10 minutes, single use)
  morndo-fleet node list            registered nodes
  morndo-fleet node revoke <name>   cut a node off; its live connection closes at once if the service runs
  morndo-fleet status               whether the service runs, its nodes, and the alerts of the last day

Settings: ~/.config/morndo-fleet/config.json, or the file MORNDO_FLEET_CONFIG names.`;

const EXIT_USAGE = 2;
const EXIT_CONFIG = 78;                                  // EX_CONFIG (sysexits.h): fix a setting or the data, don't restart
// The console's own output for the person at the box (a join string must show as it is): not a log.
const print = (text: string) => process.stdout.write(`${text}\n`);
// A refusal says its sentence and asks to leave with its code; the one catch at the bottom leaves, after the sentence is out
// (service-kit exit-after-output.ts). The helpers below are not async, so it is thrown, not awaited.
class Exit extends Error {
  readonly code: number;
  constructor(code: number) { super(`exit ${code}`); this.name = "Exit"; this.code = code; }
}
const fail = (text: string, code: number): never => { process.stderr.write(`${text}\n`); throw new Exit(code); };
const when = (t: number | null) => (t === null ? "-" : new Date(t).toISOString());

function config(): FleetConfig {
  try { return loadConfig(); }
  catch (e) { if (e instanceof ConfigError) return fail(e.message, EXIT_CONFIG); throw e; }
}

function openDb(path: string): Database.Database {
  try { return openFleetDb(path); }
  catch (e) {
    if (e instanceof DatabaseUnreadable || e instanceof NotLocalDisk) return fail(e.message, EXIT_CONFIG);
    if (!(e instanceof DatabaseFromFuture)) throw e;
    return fail(`${path} was written by a newer morndo-fleet (schema version ${e.found}); this one knows migrations only up to ${e.known}. Run the newer one, or restore a backup.`, EXIT_CONFIG);
  }
}

// The database's directory on this machine's own disk (service-kit local-disk.ts), asked before anything is made there.
function localDisk(dbPath: string): void {
  try { assertLocalDisk(dirname(dbPath)); }
  catch (e) { if (e instanceof NotLocalDisk) fail(e.message, EXIT_CONFIG); throw e; }
}

function fleetKey(path: string): FleetKey {
  try { return loadOrCreateFleetKey(path); }
  catch (e) { if (e instanceof KeyFileUnsafe) return fail(e.message, EXIT_CONFIG); throw e; }
}

quietBrokenPipe();                                       // `morndo-fleet node list | head` ends the output, not the process
const [cmd, sub, ...args] = process.argv.slice(2);
if (cmd === "--version") {
  print(buildLabel());
  await exitAfterOutput(0);
}

try {
  if (cmd === "serve") {
    exitOnCrash(log);
    const cfg = config();
    const fleet = await startFleet(cfg).catch((e: unknown) => {
      if (e instanceof DatabaseFromFuture) return fail(`${cfg.dbPath} was written by a newer morndo-fleet (schema version ${e.found}); this one knows migrations only up to ${e.known}.`, EXIT_CONFIG);
      if (e instanceof KeyFileUnsafe || e instanceof DatabaseUnreadable || e instanceof NotLocalDisk || e instanceof SocketDirUnsafe || e instanceof SocketInUse) return fail(e.message, EXIT_CONFIG);
      throw e;
    });
    log.info(`morndo-fleet ${buildLabel()}: agents on ws://${cfg.listen.host}:${fleet.agentPort}/agent`);
    const stop = async () => { await fleet.close(); await exitAfterOutput(0); };
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
  } else if (cmd === "node" && sub === "add") {
    const name = args[0] ?? "";
    if (!NODE_NAME.test(name)) fail(`a node name is 1 to 32 of a-z, 0-9 and "-": ${JSON.stringify(name)}`, EXIT_USAGE);
    if (!isNodeName(name)) fail(`${JSON.stringify(name)} is reserved: it names the control plane's own machine`, EXIT_USAGE);
    const cfg = config();
    localDisk(cfg.dbPath);                                  // before the key file or the database is made
    const key = fleetKey(cfg.keyPath);
    const db = openDb(cfg.dbPath);
    const issued = new NodesStore(db).issueCode(name);
    if (!issued.ok) { db.close(); fail(`node ${name} is registered; revoke it first to join it again`, 1); }
    else {
      new Audit(db).record("cli", "node.add", name, { expiresAt: issued.expiresAt });
      db.close();
      print(`Join string for node ${name}, single use, valid until ${when(issued.expiresAt)}:\n`);
      print(formatJoinString({ url: cfg.publicUrl, fleetKey: key.publicKey, code: issued.code, node: name }));
      print(`\nOn that machine run: morndo-node join '<the join string>'`);
    }
  } else if (cmd === "node" && sub === "list") {
    const db = openDb(config().dbPath);
    const nodes = new NodesStore(db).list();
    db.close();
    if (nodes.length === 0) print("no nodes; add one with: morndo-fleet node add <name>");
    for (const n of nodes) {
      print(`${n.name.padEnd(32)}  ${n.revokedAt === null ? "active " : "REVOKED"}  joined ${when(n.createdAt)}  last seen ${when(n.lastSeenAt)}  from ${n.lastSource ?? "-"}  agent ${n.agentVersion ?? "-"}`);
    }
  } else if (cmd === "node" && sub === "revoke") {
    const name = args[0] ?? "";
    if (!NODE_NAME.test(name)) fail(`a node name is 1 to 32 of a-z, 0-9 and "-": ${JSON.stringify(name)}`, EXIT_USAGE);
    const cfg = config();
    const db = openDb(cfg.dbPath);
    // The same revoked.log the service writes (RL10, updates design §11.5), so this revoke survives a fleet.db put
    // back from an older copy as the service's own revocations do.
    const revoked = new NodesStore(db, Date.now, new RevocationJournal(join(dirname(cfg.dbPath), "revoked.log"))).revoke(name);
    if (revoked) new Audit(db).record("cli", "node.revoke", name);
    db.close();
    if (!revoked) fail(`no active node ${name}`, 1);
    // The running service closes the node's connection and drops its lanes at once; it re-checks every node it holds
    // each ping interval anyway, and refuses a revoked node at its next hello.
    const told = await socketRequest(cfg.socketPath, "POST", `/v1/nodes/${encodeURIComponent(name)}/revoke`);
    if (told?.status === 200) print(`revoked ${name}; its connection, if any, is closed`);
    else print(`revoked ${name}; the fleet service did not answer at ${cfg.socketPath}, so it applies within ${LIMITS.pingMs / 1000} s if it runs, else when it starts`);
  } else if (cmd === "status") {
    const cfg = config();
    const live = await socketRequest(cfg.socketPath, "GET", "/v1/nodes");
    const db = openDb(cfg.dbPath);
    const registered = new NodesStore(db).list().filter(n => n.revokedAt === null);
    const alerts = new Audit(db).alerts(Date.now() - 24 * 3_600_000);
    const outbox = new OutboxStore(db);
    const bus = cfg.subscribers.map(s => ({ name: s.name, ...outbox.summary(s.name) }));
    const unrouted = outbox.unrouted();
    db.close();
    if (live?.status === 200 && Array.isArray(live.body)) {
      print(`fleet service: running (${cfg.socketPath})`);
      for (const n of live.body as { name: string; status: string; agent: string | null }[]) print(`  ${n.name.padEnd(32)}  ${n.status.padEnd(7)}  agent ${n.agent ?? "-"}`);
    } else {
      print(`fleet service: NOT REACHABLE at ${cfg.socketPath}`);
      for (const n of registered) print(`  ${n.name.padEnd(32)}  last seen ${when(n.lastSeenAt)}`);
    }
    print(bus.length === 0 ? "hook bus: no subscribers" : "hook bus, per subscriber:");
    for (const b of bus) {
      print(`  ${b.name.padEnd(32)}  ${b.pending} waiting  ${b.dead} dead letters${b.latest ? ` (latest ${when(b.latest.at)}: ${b.latest.reason})` : ""}`);
    }
    print(unrouted.length === 0 ? "hook events no subscriber takes: none" : "hook events no subscriber takes (acknowledged and counted, never delivered):");
    for (const u of unrouted) print(`  ${u.path.padEnd(14)}  ${u.count}  (latest ${when(u.latestAt)})`);
    print(alerts.length === 0 ? "alerts in the last 24 h: none" : `alerts in the last 24 h: ${alerts.length}`);
    for (const a of alerts) print(`  ${when(a.at)}  ${a.action}${a.node ? `  ${a.node}` : ""}  ${JSON.stringify(a.detail)}`);
    if (live?.status !== 200) process.exitCode = 1;
  } else {
    print(HELP);
    if (cmd !== undefined && cmd !== "help") process.exitCode = EXIT_USAGE;
  }
} catch (e) {
  if (!(e instanceof Exit)) throw e;
  await exitAfterOutput(e.code);
}
