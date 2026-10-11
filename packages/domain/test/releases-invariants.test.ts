// The invariants RL1–RL14 (docs/design/updates/README.md §4.2; ADR-0019). One negative control per invariant: a
// history that breaks it must be refused. The happy paths sit beside them. Everything here is decided, not done: no
// signature is verified, no service stopped, no clock read — the functions take facts and `now`.
import { describe, expect, it } from "vitest";
import {
  acceptFeed, acceptKeySets, admit, applyRevocationJournal, DEFAULT_CHANNEL, DEFAULT_MODE, formatVersion,
  holdsWrites, hubAnswerAfterRestore, judgeHealth, judgeProbation, judgeVerification, mayRestore, mayStopNodeAgent,
  maySwap, parseVersion, planMigrations, safeToApply, skew, updateTouches, writeDuringHold,
  type ChannelFeed, type Installation, type KeySet, type OfferedKeySet, type Version,
} from "../src/releases.ts";

const v = (s: string): Version => {
  const p = parseVersion(s);
  if (!p) throw new Error(`${s} did not parse`);
  return p;
};
const DAY = 86_400_000;
const MIN = 60_000;
const NOW = 1_790_000_000_000;

const keySet = (version: number, root: string[] = ["root-a"], others: { release?: string[]; feed?: string[]; expiresAt?: number } = {}): KeySet =>
  ({ schema: 1, version, expiresAt: others.expiresAt ?? NOW + 365 * DAY, root, release: others.release ?? ["rel-1"], feed: others.feed ?? ["feed-1"] });
const offered = (set: KeySet, signedBy: string[]): OfferedKeySet => ({ set, signedBy });

const feed = (over: Partial<ChannelFeed> = {}): ChannelFeed => ({
  schema: 1, channel: "stable", seq: 43, issuedAt: NOW - 5 * MIN, expiresAt: NOW + 14 * DAY, keySetVersion: 1,
  releases: [{ version: "0.5.0", manifest: "https://github.com/morndo/morndo/releases/download/v0.5.0/manifest.json",
    manifestSize: 2048, manifestSha256: "ab".repeat(32) }],
  withdrawn: [], ...over,
});

const machine = (over: Partial<Installation> = {}): Installation => ({
  current: v("0.4.3"), previous: v("0.4.2"), staged: null,
  badVersions: [], highestCommitted: v("0.4.3"),
  keySet: keySet(1), highestFeedSeq: { stable: 42, latest: 42 },
  installMethod: "updater",
  settings: { channel: "stable", mode: "apply", pin: null, window: null },
  ...over,
});

describe("RL1 verified before unpacked", () => {
  const allTrue = { feed_signature: true, feed_namespace: true, feed_channel: true, feed_fresh: true, feed_seq: true,
    manifest_version: true, manifest_digest: true, manifest_signature: true, manifest_namespace: true,
    artifact_size: true, artifact_digest: true, file_list: true };
  it("every check in order, all true, verifies", () => {
    expect(judgeVerification(allTrue)).toEqual({ ok: true, value: true });
  });
  it("negative control: a manifest whose digest is not the ChannelFeed entry's is refused, naming the check", () => {
    expect(judgeVerification({ ...allTrue, manifest_digest: false })).toEqual({ ok: false, error: "manifest_digest" });
  });
  it("negative control: a missing check is a failed check — no flag skips one", () => {
    const { feed_seq: gone, ...rest } = allTrue;
    expect(judgeVerification(rest)).toEqual({ ok: false, error: "feed_seq" });
  });
  it("negative control: --to with no ChannelFeed entry never stages (every install goes through one)", () => {
    const r = admit({ machine: machine(), switches: { disableAutoUpdate: false, disableUpdates: false },
      ask: { kind: "to", version: v("0.5.0"), allowDowngrade: false }, offered: null, rolloutHalted: false });
    expect(r).toEqual({ ok: false, error: "no_entry" });
  });
});

describe("RL2 never a downgrade unless asked", () => {
  const switches = { disableAutoUpdate: false, disableUpdates: false };
  it("auto installs only above every committed Version", () => {
    const r = admit({ machine: machine(), switches, ask: { kind: "auto" },
      offered: { version: v("0.5.0"), feed: feed() }, rolloutHalted: false });
    expect(r).toEqual({ ok: true, value: v("0.5.0") });
  });
  it("negative control: after a switch to a channel offering less, auto never moves the machine down", () => {
    const onLatest = machine({ highestCommitted: v("0.5.0"), current: v("0.5.0"), settings: { channel: "stable", mode: "apply", pin: null, window: null } });
    const r = admit({ machine: onLatest, switches, ask: { kind: "auto" },
      offered: { version: v("0.4.9"), feed: feed({ channel: "stable", releases: feed().releases.map(e => ({ ...e, version: "0.4.9" })) }) }, rolloutHalted: false });
    expect(r).toEqual({ ok: false, error: "not_newer" });
  });
  it("negative control: a withdrawn release is never offered", () => {
    const r = admit({ machine: machine(), switches, ask: { kind: "auto" },
      offered: { version: v("0.5.1"), feed: feed({ releases: [{ ...feed().releases[0]!, version: "0.5.1" }], withdrawn: ["0.5.1"] }) }, rolloutHalted: false });
    expect(r).toEqual({ ok: false, error: "withdrawn" });
  });
  it("negative control: --to a lower Version without --allow-downgrade is refused", () => {
    const r = admit({ machine: machine(), switches, ask: { kind: "to", version: v("0.4.0"), allowDowngrade: false },
      offered: { version: v("0.4.0"), feed: feed({ releases: [{ ...feed().releases[0]!, version: "0.4.0" }] }) }, rolloutHalted: false });
    expect(r).toEqual({ ok: false, error: "downgrade_refused" });
  });
  it("the principal's named downgrade, and a rollback, are heard", () => {
    const named = admit({ machine: machine(), switches, ask: { kind: "to", version: v("0.4.0"), allowDowngrade: true },
      offered: { version: v("0.4.0"), feed: feed({ releases: [{ ...feed().releases[0]!, version: "0.4.0" }] }) }, rolloutHalted: false });
    expect(named).toEqual({ ok: true, value: v("0.4.0") });
    const back = admit({ machine: machine(), switches, ask: { kind: "rollback" }, offered: null, rolloutHalted: false });
    expect(back).toEqual({ ok: true, value: v("0.4.2") });
  });
  it("negative control: --rollback away from a halted, pinned, withdrawn Version is heard (those guard moving TO one)", () => {
    const stuck = machine({ current: v("0.5.0"), previous: v("0.4.3"), highestCommitted: v("0.5.0"),
      settings: { channel: "stable", mode: "apply", pin: v("0.5.0"), window: null } });
    const r = admit({ machine: stuck, switches, ask: { kind: "rollback" },
      offered: { version: v("0.5.0"), feed: feed({ releases: [{ ...feed().releases[0]!, version: "0.5.0" }], withdrawn: ["0.4.3"] }) },
      rolloutHalted: true });
    expect(r).toEqual({ ok: true, value: v("0.4.3") });
  });
});

describe("RL3 trust moves forward loudly", () => {
  it("a fresh ChannelFeed on the right channel, seq and key set is accepted", () => {
    const r = acceptFeed(feed(), { channel: "stable", highestSeq: 42, keySetVersion: 1 }, NOW);
    expect(r).toEqual({ ok: true, value: feed() });
  });
  it("negative control: a ChannelFeed with a lower seq than the highest ever seen is refused", () => {
    expect(acceptFeed(feed({ seq: 41 }), { channel: "stable", highestSeq: 42, keySetVersion: 1 }, NOW))
      .toEqual({ ok: false, error: "older" });
  });
  it("negative control: an expired ChannelFeed is refused as stale, not applied", () => {
    expect(acceptFeed(feed({ expiresAt: NOW - 1 }), { channel: "stable", highestSeq: 42, keySetVersion: 1 }, NOW))
      .toEqual({ ok: false, error: "stale" });
  });
  it("negative control: a ChannelFeed signed by another key set than the trusted one is refused", () => {
    expect(acceptFeed(feed({ keySetVersion: 2 }), { channel: "stable", highestSeq: 42, keySetVersion: 1 }, NOW))
      .toEqual({ ok: false, error: "other_key_set" });
  });
  it("negative control: the wrong channel is refused", () => {
    expect(acceptFeed(feed({ channel: "latest" }), { channel: "stable", highestSeq: 42, keySetVersion: 1 }, NOW))
      .toEqual({ ok: false, error: "wrong_channel" });
  });
  it("a key set walks one version at a time, signed by the old root — and by the new one when it rotates", () => {
    const have = keySet(1, ["root-a"]);
    const rotated = keySet(2, ["root-b"]);
    expect(acceptKeySets(have, [offered(rotated, ["root-a", "root-b"])], NOW)).toEqual({ ok: true, value: rotated });
  });
  it("negative control: a gap in key set versions is refused (never jumps)", () => {
    expect(acceptKeySets(keySet(1), [offered(keySet(3), ["root-a"])], NOW)).toEqual({ ok: false, error: "gap" });
  });
  it("negative control: an offered version at or below the trusted one is refused (never rolls back)", () => {
    expect(acceptKeySets(keySet(1), [offered(keySet(1, ["root-b"]), ["root-a"])], NOW)).toEqual({ ok: false, error: "older" });
    expect(acceptKeySets(keySet(2), [offered(keySet(1), ["root-a"])], NOW)).toEqual({ ok: false, error: "older" });
  });
  it("negative control: a rotation signed only by the new root, or only by the old one, is refused", () => {
    expect(acceptKeySets(keySet(1), [offered(keySet(2, ["root-b"]), ["root-b"])], NOW)).toEqual({ ok: false, error: "unsigned_by_root" });
    expect(acceptKeySets(keySet(1), [offered(keySet(2, ["root-b"]), ["root-a"])], NOW)).toEqual({ ok: false, error: "root_change_one_side" });
  });
  it("negative control: the newest key set must be unexpired, though an expired one may vouch for the next", () => {
    const chain = [offered(keySet(2, ["root-a"], { expiresAt: NOW - DAY }), ["root-a"]), offered(keySet(3, ["root-a"]), ["root-a"])];
    expect(acceptKeySets(keySet(1), chain, NOW)).toEqual({ ok: true, value: keySet(3) });
    const staleNewest = [chain[0]!, offered(keySet(3, ["root-a"], { expiresAt: NOW - DAY }), ["root-a"])];
    expect(acceptKeySets(keySet(1), staleNewest, NOW)).toEqual({ ok: false, error: "expired" });
  });
});

describe("RL4 one Update at a time, each step recorded before it runs", () => {
  // The state machine's own table is in releases-state.test.ts; here is the invariant: nothing acts without the
  // apply lock, and a mutating step is on record (started, not done) before it may run.
  it("negative control: a live record with no apply lock held is refused — a second actor never acts", async () => {
    const { beginStep, beginUpdate, recover } = await import("../src/releases.ts");
    const u = beginUpdate({ target: v("0.5.0"), machine: machine() });
    const step = beginStep(u, "draining", { lockHeld: false });
    expect(step).toEqual({ ok: false, error: "apply_lock" });
    expect(recover({ format: 1, mark: "swapping", committed: false, current: v("0.4.3"), preUpdate: { current: v("0.4.3") }, target: v("0.5.0"), lockHeld: false }))
      .toEqual({ ok: false, error: "apply_lock" });
  });
  it("with the lock, the mark is written before the step runs, and only in order", async () => {
    const { beginStep, beginUpdate } = await import("../src/releases.ts");
    const u = beginUpdate({ target: v("0.5.0"), machine: machine() });
    const begun = beginStep(u, "draining", { lockHeld: true });
    expect(begun.ok && begun.value.mark).toBe("draining");   // recorded started, not done-after
    expect(beginStep(u, "swapping", { lockHeld: true })).toEqual({ ok: false, error: "step_out_of_order" });
  });
});

describe("RL5 no swap without a checked Backup", () => {
  const plan = planMigrations({
    databases: { hub: { schema: 17, floor: 17 }, fleet: { schema: 15, floor: 15 }, node: { schema: 6, floor: 3 }, connections: { schema: 1, floor: 1 } },
    target: { hub: { version: 19, floor: 17 }, fleet: { version: 15, floor: 15 }, node: { version: 6, floor: 3 }, connections: { version: 1, floor: 1 } },
    previous: { hub: { version: 17, floor: 17 }, fleet: { version: 15, floor: 15 }, node: { version: 6, floor: 3 }, connections: { version: 1, floor: 1 } },
  });
  it("a database that migrates needs a Backup; one that doesn't, doesn't", () => {
    expect(plan.hub).toMatchObject({ willMigrate: true, backupRequired: true, expectedSchema: 17 });
    expect(plan.fleet).toMatchObject({ willMigrate: false, backupRequired: false });
  });
  it("negative control: swapping with a migration and no Backup is refused before anything moves", () => {
    expect(maySwap(plan, [])).toEqual({ ok: false, error: { database: "hub", reason: "backup_missing" } });
  });
  it("negative control: a Backup that failed its integrity check, or checks the wrong schema, is no Backup", () => {
    expect(maySwap(plan, [{ database: "hub", done: true, passedCheck: false, schema: 17 }]))
      .toEqual({ ok: false, error: { database: "hub", reason: "backup_failed" } });
    expect(maySwap(plan, [{ database: "hub", done: true, passedCheck: true, schema: 19 }]))
      .toEqual({ ok: false, error: { database: "hub", reason: "backup_wrong_schema" } });
  });
  it("a taken, checked Backup at the expected schema lets the swap through", () => {
    expect(maySwap(plan, [{ database: "hub", done: true, passedCheck: true, schema: 17 }])).toEqual({ ok: true, value: true });
  });
});

describe("RL6 only at a safe point", () => {
  const quiet = [{ service: "hub" as const, blockers: [] }, { service: "fleet" as const, blockers: [] }, { service: "node" as const, blockers: [] }];
  it("negative control: work in flight is never skipped, not even by --now", () => {
    const busy = [{ service: "hub" as const, blockers: ["a Decision being typed"] }, ...quiet.slice(1)];
    const r = safeToApply({ reports: busy, automatic: true, machineRunsHub: true, attending: false, window: null, localMinutes: 600, now: true });
    expect(r).toEqual({ ok: false, error: [{ kind: "in_flight", service: "hub", blocker: "a Decision being typed" }] });
  });
  it("negative control: an automatic update of a hub machine waits while someone is attending", () => {
    const r = safeToApply({ reports: quiet, automatic: true, machineRunsHub: true, attending: true, window: null, localMinutes: 600, now: false });
    expect(r).toEqual({ ok: false, error: [{ kind: "attending" }] });
  });
  it("negative control: an automatic update waits for its window", () => {
    const window = { start: 1320, end: 1380 };   // 22:00–23:00 local
    expect(safeToApply({ reports: quiet, automatic: true, machineRunsHub: true, attending: false, window, localMinutes: 600, now: false }))
      .toEqual({ ok: false, error: [{ kind: "window" }] });
  });
  it("--now skips only the attending and window waits; a quiet machine applies in its window", () => {
    const window = { start: 1320, end: 1380 };
    expect(safeToApply({ reports: quiet, automatic: true, machineRunsHub: true, attending: true, window, localMinutes: 600, now: true }))
      .toEqual({ ok: true, value: true });
    expect(safeToApply({ reports: quiet, automatic: true, machineRunsHub: true, attending: false, window, localMinutes: 1350, now: false }))
      .toEqual({ ok: true, value: true });
  });
  it("a window may wrap past midnight", async () => {
    const { windowContains } = await import("../src/releases.ts");
    const wrap = { start: 1380, end: 60 };   // 23:00–01:00
    expect(windowContains(wrap, 0)).toBe(true);
    expect(windowContains(wrap, 1395)).toBe(true);
    expect(windowContains(wrap, 720)).toBe(false);
  });
});

describe("RL7 health failures roll back", () => {
  const baseline = { hub: ["/api/health", "schema"], fleet: ["socket"] };
  const after = [
    { service: "hub", version: "0.5.0", checks: { "/api/health": true, schema: true } },
    { service: "fleet", version: "0.5.0", checks: { socket: true } },
  ];
  it("what passed before passes after: healthy", () => {
    expect(judgeHealth({ baseline, after })).toEqual({ ok: true, value: true });
  });
  it("negative control: a check that passed before and fails after is named, service and check", () => {
    const broken = [{ ...after[0]!, checks: { "/api/health": false, schema: true } }, after[1]!];
    expect(judgeHealth({ baseline, after: broken })).toEqual({ ok: false, error: { service: "hub", check: "/api/health" } });
  });
  it("negative control: a service that doesn't answer within the deadline fails its health", () => {
    expect(judgeHealth({ baseline, after: [after[0]!] })).toEqual({ ok: false, error: { service: "fleet", check: "no_report" } });
  });
  it("a check that failed before is not held against the target", () => {
    expect(judgeHealth({ baseline: { hub: ["/api/health"] }, after: [{ service: "hub", version: "0.5.0", checks: { "/api/health": true, disk_space: false } }] }))
      .toEqual({ ok: true, value: true });
  });
  it("probation: 60 seconds up and no restart", () => {
    expect(judgeProbation({ upMs: 59_999, restarts: 0 })).toEqual({ ok: false, error: "not_up" });
    expect(judgeProbation({ upMs: 60_000, restarts: 0 })).toEqual({ ok: true, value: true });
    expect(judgeProbation({ upMs: 60_000, restarts: 1 })).toEqual({ ok: false, error: "restarted" });
  });
});

describe("RL8 no Version below the floor", () => {
  const breaking = planMigrations({
    databases: { hub: { schema: 17, floor: 17 }, fleet: { schema: 15, floor: 15 }, node: { schema: 6, floor: 3 }, connections: { schema: 1, floor: 1 } },
    target: { hub: { version: 19, floor: 19 }, fleet: { version: 15, floor: 15 }, node: { version: 6, floor: 3 }, connections: { version: 1, floor: 1 } },
    previous: { hub: { version: 17, floor: 17 }, fleet: { version: 15, floor: 15 }, node: { version: 6, floor: 3 }, connections: { version: 1, floor: 1 } },
  });
  it("a rollback across a raised floor must restore that database", () => {
    expect(breaking.hub).toMatchObject({ restoreOnRollback: true });
    expect(breaking.fleet).toMatchObject({ restoreOnRollback: false });
  });
  it("negative control: a rollback below the floor with the Backup gone is refused", () => {
    expect(mayRestore({ database: "hub", restoreOnRollback: true, backupPresent: false })).toEqual({ ok: false, error: "backup_gone" });
  });
  it("a database the previous Version still opens is left alone, with everything written since", () => {
    expect(mayRestore({ database: "fleet", restoreOnRollback: false, backupPresent: false })).toEqual({ ok: false, error: "not_required" });
    expect(mayRestore({ database: "hub", restoreOnRollback: true, backupPresent: true })).toEqual({ ok: true, value: true });
  });
});

describe("RL9 probation holds what a restore would lose", () => {
  const breaking = planMigrations({
    databases: { hub: { schema: 17, floor: 17 }, fleet: { schema: 15, floor: 15 }, node: { schema: 6, floor: 3 }, connections: { schema: 1, floor: 1 } },
    target: { hub: { version: 19, floor: 19 }, fleet: { version: 15, floor: 15 }, node: { version: 6, floor: 3 }, connections: { version: 1, floor: 1 } },
    previous: { hub: { version: 17, floor: 17 }, fleet: { version: 15, floor: 15 }, node: { version: 6, floor: 3 }, connections: { version: 1, floor: 1 } },
  });
  const flat = planMigrations({
    databases: { hub: { schema: 17, floor: 17 }, fleet: { schema: 15, floor: 15 }, node: { schema: 6, floor: 3 }, connections: { schema: 1, floor: 1 } },
    target: { hub: { version: 17, floor: 17 }, fleet: { version: 15, floor: 15 }, node: { version: 6, floor: 3 }, connections: { version: 1, floor: 1 } },
    previous: { hub: { version: 17, floor: 17 }, fleet: { version: 15, floor: 15 }, node: { version: 6, floor: 3 }, connections: { version: 1, floor: 1 } },
  });
  it("a plan that would restore on rollback holds writes; one that wouldn't, doesn't", () => {
    expect(holdsWrites(breaking)).toBe(true);
    expect(holdsWrites(flat)).toBe(false);
  });
  it("negative control: from start until commit, every write but a revocation is refused as updating", () => {
    for (const kind of ["command", "decision", "board_write", "pairing", "operation", "hook_ack", "keyed_operation", "console_write"] as const)
      expect(writeDuringHold(kind, NOW - MIN, NOW), kind).toBe("updating");
    expect(writeDuringHold("revocation", NOW - MIN, NOW)).toBe("allowed");
  });
  it("negative control: a hold older than ten minutes is ignored, so a dead updater can't hold services forever", () => {
    expect(writeDuringHold("command", NOW - 11 * MIN, NOW)).toBe("allowed");
  });
});

describe("RL10 a restore never undoes what is done", () => {
  it("negative control: a restore can't bring back a revoked device — the journal wins over the database", () => {
    expect(applyRevocationJournal(["device-2", "device-9"], ["device-9", "node-b"])).toEqual(["device-2"]);
    expect(applyRevocationJournal([], ["device-9"])).toEqual([]);
  });
  it("the journal is idempotent: applying it twice changes nothing the second time", () => {
    const once = applyRevocationJournal(["device-2", "device-9"], ["device-9"]);
    expect(applyRevocationJournal(once, ["device-9"])).toEqual(["device-2"]);
  });
  it("negative control: a Command stamped with another store is answered uncertain, never typed", () => {
    expect(hubAnswerAfterRestore({ hubStore: "s-2", stampedStore: "s-1", held: false })).toBe("uncertain");
    expect(hubAnswerAfterRestore({ hubStore: "s-2", stampedStore: "s-1", held: true })).toBe("uncertain");
  });
  it("this store's own stamp was typed; a retry of an id the hub still holds is a duplicate", () => {
    expect(hubAnswerAfterRestore({ hubStore: "s-2", stampedStore: "s-2", held: false })).toBe("typed");
    expect(hubAnswerAfterRestore({ hubStore: "s-2", stampedStore: "s-2", held: true })).toBe("duplicate");
  });
});

describe("RL11 skew stays inside the window", () => {
  const nodes = [
    { name: "node-a", version: v("0.5.1"), agentProtocol: 1, joined: true, revoked: false },
    { name: "node-b", version: v("0.5.1"), agentProtocol: 2, joined: true, revoked: false },
    { name: "node-c", version: v("0.4.0"), agentProtocol: 1, joined: true, revoked: true },
  ];
  const drop = { agent: [2, 3] as [number, number], clientApi: [1, 1] as [number, number] };
  it("a node never applies above its control plane", () => {
    expect(skew({ machine: "node", controlPlane: v("0.5.1"), nodes: [], target: v("0.6.0"), targetProtocol: drop }))
      .toEqual({ ok: false, error: { reason: "node_ahead" } });
    expect(skew({ machine: "node", controlPlane: v("0.6.0"), nodes: [], target: v("0.6.0"), targetProtocol: drop }).ok).toBe(true);
  });
  it("negative control: the control plane defers a Release that drops a protocol a joined node still speaks", () => {
    const r = skew({ machine: "control_plane", controlPlane: v("0.5.1"), nodes, target: v("0.6.0"), targetProtocol: drop });
    expect(r).toEqual({ ok: false, error: { reason: "protocol_dropped", nodes: ["node-a"] } });   // node-c is revoked
  });
  it("with every joined node inside the protocol window, the control plane applies", () => {
    const r = skew({ machine: "control_plane", controlPlane: v("0.5.1"), nodes: nodes.slice(1), target: v("0.6.0"), targetProtocol: drop });
    expect(r).toEqual({ ok: true, value: true });
  });
});

describe("RL12 a halted rollout stays halted", () => {
  it("negative control: one machine's rollback halts the Version for every other machine", async () => {
    const { beginRollout, haltRollout, nodeMayApply, resumeRollout, DEFAULT_SOAK_MINUTES } = await import("../src/releases.ts");
    const cpCommitted = NOW - (DEFAULT_SOAK_MINUTES + 5) * MIN;
    const rollout = { version: v("0.5.0"), controlPlaneCommittedAt: cpCommitted, soakMinutes: DEFAULT_SOAK_MINUTES,
      halted: false, haltedBy: null as string | null, nodes: {} as Record<string, { jitterUntil: number | null }> };
    const args = { node: "node-a", controlPlane: v("0.5.0"), now: NOW };
    expect(nodeMayApply({ rollout, ...args })).toEqual({ ok: true, value: "apply" });
    const halted = haltRollout(rollout, "node-b");
    expect(halted).toMatchObject({ halted: true, haltedBy: "node-b" });
    expect(nodeMayApply({ rollout: halted, ...args })).toEqual({ ok: false, error: "halted" });
    expect(nodeMayApply({ rollout: resumeRollout(halted), ...args })).toEqual({ ok: true, value: "apply" });
  });
  it("negative control: admit skips a halted Version, and a newer Release supersedes the halt", () => {
    const switches = { disableAutoUpdate: false, disableUpdates: false };
    expect(admit({ machine: machine(), switches, ask: { kind: "auto" }, offered: { version: v("0.5.0"), feed: feed() }, rolloutHalted: true }))
      .toEqual({ ok: false, error: "halted" });
    expect(admit({ machine: machine(), switches, ask: { kind: "auto" }, offered: { version: v("0.5.1"), feed: feed({ releases: [{ ...feed().releases[0]!, version: "0.5.1" }] }) }, rolloutHalted: false }).ok)
      .toBe(true);
  });
});

describe("RL13 Morndo updates only itself, and grants nothing", () => {
  it("negative control: a step that names anything but Morndo's own services is refused", () => {
    expect(updateTouches(["hub", "fleet", "node"])).toEqual({ ok: true, value: ["hub", "fleet", "node"] });
    expect(updateTouches(["hub", "tmux"])).toEqual({ ok: false, error: { outside: "tmux" } });
    expect(updateTouches(["node", "postgres"])).toEqual({ ok: false, error: { outside: "postgres" } });
  });
  it("negative control: the node agent is never stopped while the tmux server sits inside its unit", () => {
    expect(mayStopNodeAgent({ tmuxInAgentUnit: true })).toEqual({ ok: false, error: "tmux_in_agent_unit" });
    expect(mayStopNodeAgent({ tmuxInAgentUnit: false })).toEqual({ ok: true, value: true });
  });
});

describe("RL14 the principal's switches win", () => {
  it("negative control: MORNDO_DISABLE_UPDATES blocks every path, `morndo update` included", () => {
    const r = admit({ machine: machine(), switches: { disableAutoUpdate: false, disableUpdates: true },
      ask: { kind: "to", version: v("0.5.0"), allowDowngrade: false }, offered: { version: v("0.5.0"), feed: feed() }, rolloutHalted: false });
    expect(r).toEqual({ ok: false, error: "updates_disabled" });
  });
  it("negative control: a pinned machine stays at its pin", () => {
    const switches = { disableAutoUpdate: false, disableUpdates: false };
    const pinned = machine({ settings: { channel: "stable", mode: "apply", pin: v("0.5.0"), window: null } });
    expect(admit({ machine: pinned, switches, ask: { kind: "auto" },
      offered: { version: v("0.6.0"), feed: feed({ releases: [{ ...feed().releases[0]!, version: "0.6.0" }] }) }, rolloutHalted: false }))
      .toEqual({ ok: false, error: "pinned" });
    expect(admit({ machine: pinned, switches, ask: { kind: "auto" },
      offered: { version: v("0.5.0"), feed: feed() }, rolloutHalted: false }).ok).toBe(true);   // the pin itself applies
  });
  it("auto off stops the background path only; `morndo update` still works", () => {
    const switches = { disableAutoUpdate: false, disableUpdates: false };
    const off = machine({ settings: { channel: "stable", mode: "off", pin: null, window: null } });
    expect(admit({ machine: off, switches, ask: { kind: "auto" }, offered: { version: v("0.5.0"), feed: feed() }, rolloutHalted: false }))
      .toEqual({ ok: false, error: "disabled" });
    expect(admit({ machine: off, switches, ask: { kind: "to", version: v("0.5.0"), allowDowngrade: false },
      offered: { version: v("0.5.0"), feed: feed() }, rolloutHalted: false }).ok).toBe(true);
    expect(admit({ machine: machine(), switches: { disableAutoUpdate: true, disableUpdates: false }, ask: { kind: "auto" },
      offered: { version: v("0.5.0"), feed: feed() }, rolloutHalted: false })).toEqual({ ok: false, error: "disabled" });
  });
  it("negative control: an install the updater didn't make is never changed by it", () => {
    const r = admit({ machine: machine({ installMethod: "checkout" }), switches: { disableAutoUpdate: false, disableUpdates: false },
      ask: { kind: "auto" }, offered: { version: v("0.5.0"), feed: feed() }, rolloutHalted: false });
    expect(r).toEqual({ ok: false, error: "not_our_install" });
  });
});

describe("the owner's defaults (Q1, Q2)", () => {
  it("applies at a quiet safe point on the stable channel", () => {
    expect(DEFAULT_MODE).toBe("apply");
    expect(DEFAULT_CHANNEL).toBe("stable");
  });
});

describe("a happy history installs", () => {
  it("admit, verify, plan, safe point, swap, health, commit", async () => {
    const { beginStep, beginUpdate, commitInstallation } = await import("../src/releases.ts");
    const m = machine();
    const switches = { disableAutoUpdate: false, disableUpdates: false };
    const admitted = admit({ machine: m, switches, ask: { kind: "auto" }, offered: { version: v("0.5.0"), feed: feed() }, rolloutHalted: false });
    expect(admitted).toEqual({ ok: true, value: v("0.5.0") });
    expect(judgeVerification({ feed_signature: true, feed_namespace: true, feed_channel: true, feed_fresh: true, feed_seq: true,
      manifest_version: true, manifest_digest: true, manifest_signature: true, manifest_namespace: true,
      artifact_size: true, artifact_digest: true, file_list: true })).toEqual({ ok: true, value: true });
    const plan = planMigrations({
      databases: { hub: { schema: 19, floor: 17 }, fleet: { schema: 15, floor: 15 }, node: { schema: 6, floor: 3 }, connections: { schema: 1, floor: 1 } },
      target: { hub: { version: 19, floor: 17 }, fleet: { version: 15, floor: 15 }, node: { version: 6, floor: 3 }, connections: { version: 1, floor: 1 } },
      previous: { hub: { version: 19, floor: 17 }, fleet: { version: 15, floor: 15 }, node: { version: 6, floor: 3 }, connections: { version: 1, floor: 1 } },
    });
    expect(maySwap(plan, [])).toEqual({ ok: true, value: true });      // nothing migrates: no Backup needed
    const quiet = [{ service: "hub" as const, blockers: [] }, { service: "fleet" as const, blockers: [] }, { service: "node" as const, blockers: [] }];
    expect(safeToApply({ reports: quiet, automatic: true, machineRunsHub: true, attending: false, window: null, localMinutes: 600, now: false }).ok).toBe(true);
    let u = beginUpdate({ target: v("0.5.0"), machine: m });
    for (const mark of ["draining", "stopping", "backing_up", "swapping", "starting"] as const) {
      const step = beginStep(u, mark, { lockHeld: true });
      expect(step.ok, mark).toBe(true);
      if (step.ok) u = step.value;
    }
    expect(judgeHealth({ baseline: { hub: ["/api/health"] }, after: [{ service: "hub", version: "0.5.0", checks: { "/api/health": true } }] }).ok).toBe(true);
    const committed = commitInstallation(m, v("0.5.0"));
    expect(formatVersion(committed.current)).toBe("0.5.0");
    expect(formatVersion(committed.previous)).toBe("0.4.3");
    expect(formatVersion(committed.highestCommitted)).toBe("0.5.0");
  });
});
