// The plan's negative controls, run again (docs/design/fleet-core/README.md §12.1: "each negative control demonstrably
// fails when its guard is removed"; plan.md, "Negative controls, as data"). Each entry removes or breaks one guard in one
// file and names the test files that must then fail. A control written as a test of its own (a case named "… (negative
// control)") runs with every suite and needs no entry here.
//   node scripts/negative-controls.ts                  run every control (minutes: one worktree, one npm ci, each test twice)
//   node scripts/negative-controls.ts --only <id>      run one; repeat --only for more
//   node scripts/negative-controls.ts --check          read-only, in this checkout: every entry's text is there exactly once
//   node scripts/negative-controls.ts --list           the entries
// It never changes the checkout it was started from. It makes one temporary worktree of HEAD (git worktree add --detach;
// uncommitted changes are not in it), runs `npm ci --offline` there once, and for each control:
//   1. runs the named test files unchanged: they must pass, or the control would prove nothing (cached per file set);
//   2. applies the change: `find` must occur exactly once in `file`;
//   3. runs them again: they must fail, and print `expect` when the entry gives one;
//   4. restores the file with `git checkout -- <file>` inside the temporary worktree, and checks it is as it was.
// At the end it removes that worktree (`git worktree remove --force <its path>`) and nothing else: it never prunes.
// A control bites only when vitest reports at least one failed test and no breakage (a failed suite, a transform or syntax
// error, a module that won't load, no test files). The summary counts five outcomes apart: bit, still passes, broke, timed
// out (a run past NEGATIVE_CONTROLS_TIMEOUT_MS, default 15 minutes, has no result at all), and skipped: a control marked for
// another platform (`platform`, its test is skipped here) is not run, and is never counted as bit or as passed. --check
// checks its text all the same.
// Exit: 0 every control that applies on this platform bit (at least one did); 1 any of them did not (passed, broke, timed
// out, or an entry no longer applies), or none applied; 2 setup failed.
// Ctrl-C and SIGTERM remove the temporary worktree before exiting (130, 143).
// util.parseArgs: https://nodejs.org/docs/latest-v24.x/api/util.html#utilparseargsconfig. import.meta.main ("true when
// the current module is the entry point", added in v24.2.0, stability 1.0; engines.node is >=24.12):
// https://nodejs.org/docs/latest-v24.x/api/esm.html#importmetamain, read 2026-10-06.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";

export type Control = {
  id: string;          // "t8-no-done-keys": t<task>-<what is removed>
  task: string;        // "8", "15b"
  file: string;        // the file the control changes, from the repository root
  find: string;        // exact text, found exactly once in that file
  replace: string;     // what the control puts in its place ("" removes it)
  run: string[];       // vitest files, from the repository root, that must fail with it
  expect?: string;     // a piece of the failure the step names
  platform?: NodeJS.Platform;   // the one platform its test runs on ("linux"); elsewhere the control is skipped
};

// The platform a control needs when it is not this one (it is then skipped), or null: it runs here.
export const needs = (c: Control, platform: NodeJS.Platform = process.platform): NodeJS.Platform | null =>
  c.platform !== undefined && c.platform !== platform ? c.platform : null;

export const CONTROLS: Control[] = [
  // ---- Task 1: the protocol (01-foundation.md, Steps 7 and 10)
  { id: "t1-worker-id-leading-zeros", task: "1", file: "packages/protocol/src/worker-id.ts",
    find: String.raw`\.(0|[1-9]\d{0,8})$/`, replace: String.raw`\.(\d{1,9})$/`,
    run: ["packages/protocol/test/worker-id.test.ts"], expect: "pc.3fa2c1d0.012" },
  { id: "t1-lane-start-flags", task: "1", file: "packages/protocol/src/fleet.ts",
    find: "account: z.exactOptional(account()), resume: z.exactOptional(z.uuid())",
    replace: "account: z.exactOptional(token()), resume: z.exactOptional(sessionId())",
    run: ["packages/protocol/test/fleet.test.ts"], expect: "--dangerously-skip-permissions" },
  { id: "t1-ws-loopback-only", task: "1", file: "packages/protocol/src/fleet.ts",
    find: "|| LOOPBACK_WS.test(url)", replace: String.raw`|| /^ws:\/\/[!-~]+$/.test(url)`,
    run: ["packages/protocol/test/fleet.test.ts"], expect: "ws://100.64.0.1:8791/agent" },
  { id: "t1-branch-names", task: "1", file: "packages/protocol/src/fleet.ts",
    find: String.raw`z.regex(/^(?![-/.]|HEAD$)(?!.*(?:\.\.|\/\/|\/\.|@\{|\.lock(?:\/|$)))(?!.*[/.]$)[A-Za-z0-9._/-]{1,200}$/)`,
    replace: String.raw`z.regex(/^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/)`,
    run: ["packages/protocol/test/fleet.test.ts"], expect: "a//b" },
  { id: "t1-res-store-required", task: "1", file: "packages/protocol/src/fleet.ts",
    find: "store: z.uuid(), ok: z.literal(true)", replace: "store: z.exactOptional(z.uuid()), ok: z.literal(true)",
    run: ["packages/protocol/test/fleet.test.ts"], expect: "expected 'ok' to be 'malformed'" },
  // ---- Task 2: node-ops (Steps 19, 24, 29)
  { id: "t2-confine-normalize", task: "2", file: "packages/node-ops/src/file-rules.ts",
    find: "const asked = normalize(path);", replace: "const asked = path;",
    run: ["packages/node-ops/test/file-rules.test.ts"], expect: "missing" },
  { id: "t2-confine-real-path", task: "2", file: "packages/node-ops/src/file-rules.ts",
    find: `  if (deniedBy(real, deny)) return { ok: false, reason: "denied" };\n`, replace: "",
    run: ["packages/node-ops/test/file-rules.test.ts"], expect: "a link into a deny root" },
  { id: "t2-deny-prefix", task: "2", file: "packages/node-ops/src/file-rules.ts",
    find: `(r.endsWith("*") ? p.startsWith(r.slice(0, -1)) : p === r`, replace: `(false ? p.startsWith(r.slice(0, -1)) : p === r`,
    run: ["packages/node-ops/test/file-rules.test.ts"], expect: ".local/share/morndo" },
  { id: "t2-secret-credentials-json", task: "2", file: "packages/node-ops/src/file-rules.ts",
    find: String.raw`|\.?credentials(\.json)?)$/i`, replace: String.raw`|credentials(\.json)?)$/i`,
    run: ["packages/node-ops/test/file-rules.test.ts"], expect: ".credentials.json" },
  { id: "t2-open-no-follow", task: "2", file: "packages/node-ops/src/file-rules.ts",
    find: "constants.O_RDONLY | constants.O_NOFOLLOW", replace: "constants.O_RDONLY",
    run: ["packages/node-ops/test/file-rules.test.ts"] },
  // keryx B5 V29: the open file's dev/ino against the file confine judged (a file swapped in between check and open).
  { id: "t2-openconfined-devino", task: "2", file: "packages/node-ops/src/file-rules.ts",
    find: "if (st.dev !== c.dev || st.ino !== c.ino) { await fh.close(); return { ok: false, reason: \"denied\" }; }",
    replace: "",
    run: ["packages/node-ops/test/confine-parent-swap.test.ts"], expect: "SECRET-V29" },
  // keryx B5 V29 (controller ruling): Linux's /proc/self/fd path check. LINUX ONLY: its test is skipped elsewhere, so
  // elsewhere the control is skipped (platform); it runs, and bites, on Linux (the weekly ubuntu run).
  { id: "t2-openconfined-proc-fd", task: "2", file: "packages/node-ops/src/file-rules.ts",
    find: "if (at === null || at !== c.real || at.endsWith(\" (deleted)\")) { await fh.close(); return { ok: false, reason: \"denied\" }; }",
    replace: "",
    run: ["packages/node-ops/test/confine-parent-swap.test.ts"], expect: "SECRET-V29", platform: "linux" },
  // keryx B5 V28: each existing entry under a "*" deny root, resolved (a service directory that is itself a link).
  { id: "t2-star-entry-resolve", task: "2", file: "packages/node-ops/src/file-rules.ts",
    find: "try { const er = realpathSync.native(entry); if (er !== entry) out.push(er); } catch { /* gone meanwhile */ }",
    replace: "",
    run: ["packages/node-ops/test/confine-star-linked-entry.test.ts"], expect: "denied" },
  { id: "t2-hub-files-denied-by", task: "2", file: "apps/hub/src/adapters/files.ts",
    find: "|| deniedBy(real, resolvedRoots(opts.deny));", replace: "|| opts.deny.some(d => real === d || real.startsWith(`${d}/`));",
    run: ["apps/hub/test/files.test.ts"], expect: "fleet.db" },
  { id: "t2-tmux-u", task: "2", file: "packages/node-ops/src/tmux-cli.ts",
    find: `return ["-u", ...(socket`, replace: "return [...(socket",
    run: ["packages/node-ops/test/tmux-cli.test.ts"], expect: "'-u', 'list-sessions'" },
  { id: "t2-tmux-literal", task: "2", file: "packages/node-ops/src/tmux-cli.ts",
    find: `  const doubled = s.replaceAll("#", "##");`, replace: "  const doubled = s;",
    run: ["packages/node-ops/test/tmux-cli.test.ts"], expect: "amain b" },
  { id: "t2-kill-waits", task: "2", file: "packages/node-ops/test/isolated-tmux.ts",
    find: "    for (let i = 0; i < 100 && !gone(); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);\n", replace: "",
    run: ["packages/node-ops/test/tmux-cli.test.ts"], expect: "to throw" },
  { id: "t2-kill-removes-socket", task: "2", file: "packages/node-ops/test/isolated-tmux.ts",
    find: "    rmSync(join(process.env.TMUX_TMPDIR || \"/tmp\", `tmux-${process.getuid?.() ?? 0}`, socket), { force: true });\n", replace: "",
    run: ["packages/node-ops/test/tmux-cli.test.ts"], expect: "expected true to be false" },
  { id: "t2-health-tmux-ok", task: "2", file: "packages/node-ops/src/health.ts",
    find: `["list-sessions"]`, replace: `["-V"]`,
    run: ["packages/node-ops/test/stamp-health.test.ts"], expect: "expected true to be false" },
  { id: "t2-stamp-kept", task: "2", file: "packages/node-ops/src/stamp.ts",
    find: `    const known = await read();\n    if (known) return known;\n    try { await tmux(["set-option", "-g", "-o", "@morndo-server", randomUUID()]); }`,
    replace: `    try { await tmux(["set-option", "-g", "@morndo-server", randomUUID()]); }`,
    run: ["packages/node-ops/test/stamp-health.test.ts"], expect: "keeps a stamp that is already there" },
  // ---- Task 3: transcript bytes and the reader (Steps 4, 10)
  { id: "t3-locate-window-edge", task: "3", file: "packages/node-ops/src/transcript-bytes.ts",
    find: "after = buf.subarray(0, n.length - 1);", replace: "after = Buffer.alloc(0);",
    run: ["packages/node-ops/test/transcript-bytes.test.ts"], expect: "a needle across the edge" },
  { id: "t3-no-carry", task: "3", file: "apps/hub/src/adapters/claude-sessions.ts",
    find: "    else cursor.carry = carried;", replace: "    else { /* no carry */ }",
    run: ["apps/hub/test/transcript-long-lines.test.ts"], expect: "a 3 MB line arrives whole" },
  { id: "t3-no-skip", task: "3", file: "apps/hub/src/adapters/claude-sessions.ts",
    find: "    if (length > maxLine) { cursor.skip", replace: "    if (false) { cursor.skip",
    run: ["apps/hub/test/transcript-long-lines.test.ts"], expect: "a 10 MB line is one message too large" },
  { id: "t3-older-past-long-line", task: "3", file: "apps/hub/src/adapters/claude-sessions.ts",
    find: "  if (!page.length && at > 0) {", replace: "  if (false) {",
    run: ["apps/hub/test/transcript-long-lines.test.ts"], expect: "never asking twice" },
  { id: "t3-follow-keeps-place", task: "3", file: "apps/hub/src/adapters/claude-sessions.ts",
    find: "    delete cursor.sends; delete cursor.latest; delete cursor.carry; delete cursor.skip;\n    Object.assign(cursor, before);\n", replace: "",
    run: ["apps/hub/test/transcript-long-lines.test.ts"], expect: "leaves the cursor as it was" },

  // ---- Tasks 4 and 5: the hub's async ports and keys (02-hub-async.md; each step's "Then check that it bites").
  { id: "t4-sequential-poll", task: "4", file: "apps/hub/src/application/observation-service.ts",
    find: "    const rounds: Promise<void>[] = [];\n    let behind = false;                                          // a node whose earlier round still runs\n    for (const [node, ids] of byNode) {\n      if (states && states.get(node) !== \"online\") continue;      // not online: skipped at once\n      if (this.#working.has(node)) { behind = true; continue; }    // its last round still runs: no second one on top\n      this.#working.add(node);\n      rounds.push(this.#pollNode(ids).then(\n        r => { this.#arrived.push(r); },\n        (e: unknown) => { log.warn(`observation: node ${node} failed this round: ${(e as Error).message}`); },\n      ).finally(() => { this.#working.delete(node); }));\n    }\n    if (!rounds.length) return !behind;\n    let timer: NodeJS.Timeout | undefined;\n    let inTime = false;\n    const waited = new Promise<void>(resolve => { timer = setTimeout(resolve, this.#nodeWaitMs); });\n    try { await Promise.race([Promise.allSettled(rounds).then(() => { inTime = true; }), waited]); }\n    finally { clearTimeout(timer); }",
    replace: "    for (const [node, ids] of byNode) {                            // NEGATIVE CONTROL: one node after the other\n      if (states && states.get(node) !== \"online\") continue;\n      this.#arrived.push(await this.#pollNode(ids));\n    }\n    const inTime = true, behind = false;",
    run: ["apps/hub/test/observation-nodes.test.ts"], expect: "expected false to be true" },
  { id: "t4-source-unavailable-drops-follow", task: "4", file: "apps/hub/src/application/observation-service.ts",
    find: "      if (e instanceof SourceUnavailable && !rebuilt) return { rebuilt: false };\n",
    replace: "",
    run: ["apps/hub/test/observation-unavailable.test.ts"], expect: "expected [] to deeply equal [ 'a1:0' ]" },
  // Since B1 (V7's other-answer check, V23's kept legacy row) the hub's own row settles a retry before its key matters,
  // so this bites through the answer-keys case whose hub has lost that row ("carries the same key from any hub").
  { id: "t5-answer-key-random", task: "5", file: "apps/hub/src/application/escalation-service.ts",
    find: "answerKey(e.id, e, choice)",
    replace: "`${answerKey(e.id, e, choice)}:${Math.random()}`",
    run: ["apps/hub/test/escalation-answer-keys.test.ts"], expect: "to deeply equal [ { pane: '%0', …(2) } ]" },
  { id: "t5-answer-key-without-ask", task: "5", file: "apps/hub/src/application/escalation-service.ts",
    find: "answerKey(e.id, e, choice)",
    replace: "answerKey(e.id, { messageId: null, askedAt: 0 }, choice)",
    run: ["apps/hub/test/escalation-answer-keys.test.ts"], expect: "expected [ 'answer:ny-7:t0:option:ship' ]" },
  { id: "t5-node-offline-kept", task: "5", file: "apps/hub/src/application/steering-service.ts",
    find: "\"busy\", \"node_offline\"]);",
    replace: "\"busy\"]);",
    run: ["apps/hub/test/steering-keys.test.ts"], expect: "expected { state: 'started'" },
  // ---- Tasks 6-9: the agent (03-agent.md; each step's "Then check that it bites"). Its join's plain-ws:// control
  // changes two files, so it is in Task 18's table of controls the runner can't express.
  { id: "t6-config-fleeturl", task: "6", file: "apps/node-agent/src/config.ts",
    find: "!fleetUrlOk(c.fleetUrl)",
    replace: "!/^wss?:\\/\\/[^\\s]+$/.test(c.fleetUrl)",
    run: ["apps/node-agent/test/config.test.ts"], expect: "ws://100.64.0.1:8791/agent" },
  { id: "t6-rotate-not-stored", task: "6", file: "apps/node-agent/src/db/open.ts",
    find: "  db.prepare(\"UPDATE meta SET value = ? WHERE key = 'streamId'\").run(id);\n",
    replace: "",
    run: ["apps/node-agent/test/db.test.ts"] },
  { id: "t7-4409-no-retry", task: "7", file: "apps/node-agent/src/conn/connection.ts",
    find: "const wait = this.#retry.afterAbout(LIMITS.conflictRetryMs, CONFLICT_SPREAD, () => this.#dial());",
    replace: "const wait = 0;",
    run: ["apps/node-agent/test/connection.test.ts"], expect: "expected null to be 240000" },
  { id: "t7-4409-leaves-conflict", task: "7", file: "apps/node-agent/src/conn/connection.ts",
    find: "    if (this.#status.state !== \"conflict\") this.#set(\"connecting\", { connEpoch: null });",
    replace: "    this.#set(\"connecting\", { connEpoch: null });",
    run: ["apps/node-agent/test/connection.test.ts"] },
  { id: "t7-ping-timeout-20s", task: "7", file: "apps/node-agent/src/conn/connection.ts",
    find: "    }, this.#o.pingTimeoutMs ?? LIMITS.agentPingTimeoutMs);",
    replace: "    }, this.#o.pingTimeoutMs ?? 20_000);",
    run: ["apps/node-agent/test/connection.test.ts"] },
  { id: "t7-plain-ws-dialed", task: "7", file: "apps/node-agent/src/conn/connection.ts",
    find: "    if (!fleetUrlOk(o.url)) throw new TypeError(`the fleet URL must be wss://, or ws:// to this machine (127.0.0.1, localhost or [::1]); not dialing ${o.url}`);\n",
    replace: "",
    run: ["apps/node-agent/test/connection.test.ts"] },
  { id: "t7-no-jitter", task: "7", file: "apps/node-agent/src/conn/retry.ts",
    find: "Math.round(ms * (1 - spread + 2 * spread * this.#random()))",
    replace: "ms",
    run: ["apps/node-agent/test/retry.test.ts", "apps/node-agent/test/connection.test.ts"] },
  { id: "t8-hash-all-args", task: "8", file: "apps/node-agent/src/ops/done-keys.ts",
    find: "  const picked = fields ? Object.fromEntries(fields.map(f => [f, all[f]])) : args;",
    replace: "  const picked = args;",
    run: ["apps/node-agent/test/done-keys.test.ts", "apps/node-agent/test/executor.test.ts"] },
  { id: "t8-mismatch-bad-args", task: "8", file: "apps/node-agent/src/ops/executor.ts",
    find: "        if (prior.state === \"mismatch\") return fail(\"uncertain\", \"this key was used with other arguments: its op may have run\");",
    replace: "        if (prior.state === \"mismatch\") return fail(\"bad_args\", \"this key was used with other arguments\");",
    run: ["apps/node-agent/test/executor.test.ts"] },
  { id: "t8-key-on-unkeyed-op", task: "8", file: "apps/node-agent/src/ops/executor.ts",
    find: "    if (!keyed && req.key !== undefined) return fail(\"bad_args\", `${op} takes no key`);\n",
    replace: "",
    run: ["apps/node-agent/test/executor.test.ts"] },
  { id: "t8-args-without-op-args", task: "8", file: "apps/node-agent/src/ops/args.ts",
    find: "  const v = parseBody(OP_ARGS[op], a) as OpArgs[O] | null;",
    replace: "  const v = (typeof a === \"object\" && a !== null ? a : null) as OpArgs[O] | null;",
    run: ["apps/node-agent/test/executor.test.ts"] },
  { id: "t8-c-unescaped", task: "8", file: "apps/node-agent/src/ops/lane-ops.ts",
    find: "\"-c\", tmuxLiteral(cwd)",
    replace: "\"-c\", cwd",
    run: ["apps/node-agent/test/lane-worktree-ops.test.ts"] },
  { id: "t8-n-unescaped", task: "8", file: "apps/node-agent/src/ops/lane-ops.ts",
    find: "\"-n\", tmuxLiteral(a.name)",
    replace: "\"-n\", a.name",
    run: ["apps/node-agent/test/lane-worktree-ops.test.ts"] },
  { id: "t8-opener-wrong-home", task: "8", file: "apps/node-agent/src/ops/node-files.ts",
    find: "openConfined(path, { home: o.home,",
    replace: "openConfined(path, { home: \"/nonexistent-home\",",
    run: ["apps/node-agent/test/transcript-file-ops.test.ts"] },
  // keryx B5 V33: readChunk honours bytesRead (a file shrunk between its fstat and its read is not NUL-padded).
  { id: "t8-readchunk-bytesread", task: "8", file: "apps/node-agent/src/ops/node-files.ts",
    find: "const { bytesRead } = n > 0 ? await fh.read(buf, 0, n, offset) : { bytesRead: 0 };\n  return { bytes: buf.subarray(0, bytesRead).toString(\"base64\"), size, eof: offset + bytesRead >= size };",
    replace: "if (n > 0) await fh.read(buf, 0, n, offset);\n  return { bytes: buf.toString(\"base64\"), size, eof: offset + n >= size };",
    run: ["apps/node-agent/test/readchunk-shortread.test.ts"], expect: "eof" },
  // Since B4 (V44) pane.send's tmux send checks the deadline's signal again before its paste, so a late lock's send is
  // refused without this check too; keys have no such second check, so this bites through the late lock's pane.keys case.
  { id: "t8-late-lock-types", task: "8", file: "apps/node-agent/src/ops/pane-ops.ts",
    find: "      const late = ctx.ready();\n      if (late) return { ok: false, error: late };\n      return act(pane);",
    replace: "      return act(pane);",
    run: ["apps/node-agent/test/pane-ops.test.ts"], expect: "pane.keys past the deadline" },
  { id: "t8-inbox-no-budget", task: "8", file: "apps/node-agent/src/ops/upload-inbox.ts",
    find: "    if (bytes.length > this.#room()) return fail(\"too_large\", \"this node's disk budget for uploads and hooks is full\");\n",
    replace: "",
    run: ["apps/node-agent/test/transcript-file-ops.test.ts"] },
  { id: "t8-branch-git-check-off", task: "8", file: "apps/node-agent/src/ops/worktree-ops.ts",
    find: "  try { await run(\"git\", [\"check-ref-format\", \"--branch\", name], { timeout: 10_000 }); return true; }\n  catch { return false; }",
    replace: "  return name.length >= 0;",
    run: ["apps/node-agent/test/lane-worktree-ops.test.ts"], expect: "HEAD" },
  { id: "t9-res-without-store", task: "9", file: "apps/node-agent/src/agent.ts",
    find: "invVersion: reply.invVersion, store: streamId, ok: true",
    replace: "invVersion: reply.invVersion, ok: true",
    run: ["apps/node-agent/test/agent.test.ts"] },
  { id: "t9-store-ignores-fixed-stream", task: "9", file: "apps/node-agent/src/agent.ts",
    find: "invVersion: reply.invVersion, store: streamId, ok: true",
    replace: "invVersion: reply.invVersion, store: adb.streamId, ok: true",
    run: ["apps/node-agent/test/agent.test.ts"] },
  { id: "t9-no-rotation", task: "9", file: "apps/node-agent/src/agent.ts",
    find: "    const streamBehind = last !== null && w.streamKnown && w.ackSeq > last;",
    replace: "    const streamBehind = false;",
    run: ["apps/node-agent/test/stream.test.ts"] },
  { id: "t9-rotation-not-stored", task: "9", file: "apps/node-agent/src/agent.ts",
    find: "      streamId = rotateStreamId(adb.db);",
    replace: "      streamId = randomUUID();",
    run: ["apps/node-agent/test/stream.test.ts"] },
  { id: "t9-held-not-counted", task: "9", file: "apps/node-agent/src/relay/spool.ts",
    find: "bytes + held + size > this.#maxBytes",
    replace: "bytes + size > this.#maxBytes + 0 * held",
    run: ["apps/node-agent/test/spool.test.ts"] },
  { id: "t9-relay-no-budget", task: "9", file: "apps/node-agent/src/relay/relay-files.ts",
    find: "      if (size > this.#room()) return { ok: false, status: 503 };          // room() now reflects other in-flight copies\n",
    replace: "",
    run: ["apps/node-agent/test/relay-server.test.ts"] },
  { id: "t9-budget-ignores-held", task: "9", file: "apps/node-agent/src/agent.ts",
    find: "  const room = (): number => budget - spool.bytes() - held();",
    replace: "  const room = (): number => budget - spool.bytes();",
    run: ["apps/node-agent/test/agent.test.ts"] },
  { id: "t9-sender-throws", task: "9", file: "apps/node-agent/src/relay/stream-sender.ts",
    find: "    try { this.#spool.ack(seq); return true; }\n    catch (e) { this.#log?.warn(\"could not delete acknowledged hook events (a full disk?); they stay until a later ack\", e); return false; }",
    replace: "    this.#spool.ack(seq); return true;",
    run: ["apps/node-agent/test/stream.test.ts", "apps/node-agent/test/agent.test.ts"] },
  { id: "t9-prune-not-wired", task: "9", file: "apps/node-agent/src/agent.ts",
    find: "    try { ops.doneKeys.prune(); files.sweep(); ops.inbox.sweep(); }",
    replace: "    try { files.sweep(); ops.inbox.sweep(); }",
    run: ["apps/node-agent/test/agent.test.ts"] },
  { id: "t9-spoolfail-ack-ok", task: "9", file: "apps/node-agent/src/relay/spool.ts",
    find: "    if (this.#failWrites) throw new Error(\"the test hook spoolFail refuses every spool write\");\n    const gone = ",
    replace: "    const gone = ",
    run: ["apps/node-agent/test/spool.test.ts", "apps/node-agent/test/agent.test.ts"] },
  { id: "t9-health-other-socket", task: "9", file: "apps/node-agent/src/agent.ts",
    find: "healthProbe(config.home, { tmuxSocket: config.policy.tmuxSocket })",
    replace: "healthProbe(config.home, { tmuxSocket: \"test-control-elsewhere\" })",
    run: ["apps/node-agent/test/agent.test.ts"] },
  // keryx B5 (agent files and spool confinement), each with the regression test that must notice it gone.
  // V36: restored() bounds its ack by the stream's last seq at open (the control puts back the last seq at welcome).
  { id: "t9-restore-ack-openlastseq", task: "9", file: "apps/node-agent/src/agent.ts",
    find: "const acked = w.streamKnown && last !== null && open !== null ? Math.min(w.ackSeq, open) : 0;",
    replace: "const acked = w.streamKnown && last !== null ? Math.min(w.ackSeq, last) : 0;",
    run: ["apps/node-agent/test/restore-in-place-spool.test.ts"], expect: "new-1" },
  // V43: the relay copy's data fsynced before its rename.
  { id: "t9-relay-copy-fsync", task: "9", file: "apps/node-agent/src/relay/relay-files.ts",
    find: "const tfd = openSync(tmp, \"r\"); try { fsyncSync(tfd); } finally { closeSync(tfd); }   // the copy's data is on disk",
    replace: "",
    run: ["apps/node-agent/test/relay-copy-fsync.test.ts"], expect: "fsync" },
  // V46: a copy's bytes reserved against the budget while it runs (two concurrent copies can't both pass one check).
  { id: "t9-relay-inflight-reserve", task: "9", file: "apps/node-agent/src/relay/relay-files.ts",
    find: "this.#inflight += size;                                              // reserve against the shared budget",
    replace: "",
    run: ["apps/node-agent/test/relay-copy-budget.test.ts"], expect: "202" },
  // V32: online() guards its maxSeq read (none of the sender's methods throws in the message handler).
  { id: "t9-online-maxseq-guard", task: "9", file: "apps/node-agent/src/relay/stream-sender.ts",
    find: "try { this.#horizon = this.#spool.maxSeq(); }\n    catch (e) { this.#log?.warn(\"could not read the hook stream's max seq; progress events may not be marked late this round\", e); this.#horizon = 0; }",
    replace: "this.#horizon = this.#spool.maxSeq();",
    run: ["apps/node-agent/test/stream-sender-online-guard.test.ts"], expect: "malformed" },
  // V35: the agent's JSON-field redaction is escape-aware (a \" inside a value doesn't end it early). Since RU1 the rule
  // is the shared redactor's (@morndo/protocol redact.ts), which the agent's logger calls.
  { id: "t9-redact-escaped-quote", task: "9", file: "packages/protocol/src/redact.ts",
    find: String.raw`(?:[^"\\\\]|\\\\.)*(")`,
    replace: String.raw`[^"]*(")`,
    run: ["apps/node-agent/test/log-redact.test.ts"], expect: "hunter2" },
  // ---- Tasks 10-13: the fleet (04-fleet.md; each step's "Then check that it bites").
  { id: "t10-listen-anywhere", task: "10", file: "apps/fleet/src/config.ts",
    find: "    if (!LOOPBACK_HOST.test(l.host)) {",
    replace: "    if (!LOOPBACK_HOST.test(l.host) && false) {",
    run: ["apps/fleet/test/config.test.ts"], expect: "0.0.0.0" },
  { id: "t10-publicurl-plain", task: "10", file: "apps/fleet/src/config.ts",
    find: "  if (!fleetUrlOk(u)) throw",
    replace: "  if (!fleetUrlOk(u) && false) throw",
    run: ["apps/fleet/test/config.test.ts"], expect: "100.64.0.7:8791/agent" },
  { id: "t10-alerts-one-cap", task: "10", file: "apps/fleet/src/adapters/audit.ts",
    find: "    return [...security, ...others].sort(",
    replace: "    security.length = 0;\n    return [...security, ...others].sort(",
    run: ["apps/fleet/test/audit.test.ts"], expect: "no number of other alerts" },
  { id: "t10-no-prune", task: "10", file: "apps/fleet/src/adapters/audit.ts",
    find: "\"DELETE FROM audit WHERE at < ?\"",
    replace: "\"DELETE FROM audit WHERE at < ? AND 0\"",
    run: ["apps/fleet/test/audit.test.ts"], expect: "prune() deletes audit rows" },
  { id: "t11-no-instance-check", task: "11", file: "apps/fleet/src/application/connections.ts",
    find: "      const answered = await this.#check(cur);",
    replace: "      const answered = true;",
    run: ["apps/fleet/test/instances.test.ts"], expect: "half-open" },
  { id: "t11-no-handshake-limit", task: "11", file: "apps/fleet/src/adapters/agent-session.ts",
    find: "        if (!d.handshakes.take(d.source)) return tooMany();\n        if (!speaks(m.proto)) { refused",
    replace: "        if (!speaks(m.proto)) { refused",
    run: ["apps/fleet/test/agent-auth.test.ts"], expect: "past its bucket" },
  { id: "t11-bulk-wait-unbounded", task: "11", file: "apps/fleet/src/application/connections.ts",
    find: "        }, o.timeoutMs),",
    replace: "        }, o.timeoutMs + 600_000),",
    run: ["apps/fleet/test/requests.test.ts"], expect: "behind a hung transfer" },
  { id: "t11-bulk-full-timeout", task: "11", file: "apps/fleet/src/application/connections.ts",
    find: "        const left = Math.floor(w.o.timeoutMs - (this.#mono() - w.at));",
    replace: "        const left = w.o.timeoutMs;",
    run: ["apps/fleet/test/requests.test.ts"], expect: "what is left of its own timeout" },
  { id: "t11-no-bulk-cap", task: "11", file: "apps/fleet/src/application/connections.ts",
    find: "    if (q.waiting.length >= LIMITS.bulkQueueMax) {",
    replace: "    if (q.waiting.length >= Infinity) {",
    run: ["apps/fleet/test/requests.test.ts"], expect: "at most 8 bulk ops" },
  { id: "t11-store-from-connection", task: "11", file: "apps/fleet/src/application/requests.ts",
    find: "invVersion: res.invVersion, store: res.store });",
    replace: "invVersion: res.invVersion, store: p.store });",
    run: ["apps/fleet/test/requests.test.ts"], expect: "every answer carries its store" },
  { id: "t11-no-1009", task: "11", file: "apps/fleet/src/adapters/agent-session.ts",
    find: "    if (raw.length > LIMITS.maxMessageBytes) return close(1009, \"message too big\");\n",
    replace: "",
    run: ["apps/fleet/test/agent-auth.test.ts"], expect: "1009" },
  { id: "t11-no-retention-on-start", task: "11", file: "apps/fleet/src/serve.ts",
    find: "  pruneAudit();\n",
    replace: "",
    run: ["apps/fleet/test/liveness.test.ts"], expect: "go when the service starts" },
  { id: "t11-no-admission-audit", task: "11", file: "apps/fleet/src/application/connections.ts",
    find: "    this.#audit.record(\"agent\", \"conn.admitted\", a.node, { instanceId: a.instanceId, epoch, source: a.source });\n",
    replace: "",
    run: ["apps/fleet/test/agent-auth.test.ts"], expect: "conn.admitted" },
  { id: "t12-no-name-reservation", task: "12", file: "apps/fleet/src/application/router.ts",
    find: "    if (this.#reserved(name)) return refuse(",
    replace: "    if (false && this.#reserved(name)) return refuse(",
    run: ["apps/fleet/test/router.test.ts"], expect: "reserves its name" },
  { id: "t12-no-op-audit", task: "12", file: "apps/fleet/src/application/router.ts",
    find: "    if (SIDE_EFFECT_OPS.has(op)) this.#audited(",
    replace: "    if (false) this.#audited(",
    run: ["apps/fleet/test/router.test.ts", "apps/fleet/test/client-api.test.ts"], expect: "audits" },
  { id: "t12-events-unbounded", task: "12", file: "apps/fleet/src/adapters/client-api.ts",
    find: "        if (ws.bufferedAmount > eventsBufferBytes) {",
    replace: "        if (false) {",
    run: ["apps/fleet/test/client-api.test.ts"], expect: "falls too far behind" },
  { id: "t12-revoked-offline-lanes-kept", task: "12", file: "apps/fleet/src/application/connections.ts",
    find: "    for (const n of this.#nodes.list()) if (n.revokedAt !== null && this.#revocations.get(n.name) !== n.revokedAt) this.revoke(n.name);\n",
    replace: "",
    run: ["apps/fleet/test/client-api.test.ts"], expect: "while the node is offline" },
  { id: "t12-conflict-routed-by-name", task: "12", file: "apps/fleet/src/application/router.ts",
    find: "      if (r.kind === \"conflict\") return refuse(",
    replace: "      if (r.kind === \"conflict\" && false) return refuse(",
    run: ["apps/fleet/test/router.test.ts", "apps/fleet/test/client-api.test.ts"], expect: "lane_conflict" },
  { id: "t12-worker-id-blocked-by-conflict", task: "12", file: "apps/fleet/src/application/router.ts",
    find: "      node = ref.node;\n      workerId = target.workerId;\n",
    replace: "      node = ref.node;\n      workerId = target.workerId;\n      if (this.#lanes.list().some(l => l.conflict)) return refuse(failed(\"lane_conflict\", \"a name is in conflict\"));\n",
    run: ["apps/fleet/test/router.test.ts", "apps/fleet/test/client-api.test.ts"], expect: "still reachable by its worker ID" },
  { id: "t12-no-store-on-refusal", task: "12", file: "apps/fleet/src/adapters/client-api.ts",
    find: "      if (!parsed.ok) return json(res, 400, { ok: false, error: opError(\"bad_args\", parsed.message), store: null, storeSeq: null });",
    replace: "      if (!parsed.ok) return json(res, 400, { ok: false, error: opError(\"bad_args\", parsed.message), storeSeq: null });",
    run: ["apps/fleet/test/client-api.test.ts"], expect: "POST /v1/op answers the outcome" },
  { id: "t13-dead-letter-alert-each", task: "13", file: "apps/fleet/src/application/delivery.ts",
    find: "      if (!this.#deadEpisodes.has(s.name)) {",
    replace: "      if (true) {",
    run: ["apps/fleet/test/delivery.test.ts"], expect: "one dead_letter alert per subscriber episode" },
  { id: "t13-dead-letter-episode-never-ends", task: "13", file: "apps/fleet/src/application/delivery.ts",
    find: " this.#deadEpisodes.delete(s.name); return; }",
    replace: " return; }",
    run: ["apps/fleet/test/delivery.test.ts"], expect: "one dead_letter alert per subscriber episode" },
  { id: "t13-status-no-bus", task: "13", file: "apps/fleet/src/main.ts",
    find: "  for (const b of bus) {\n",
    replace: "  for (const b of bus.slice(0, 0)) {\n",
    run: ["apps/fleet/test/status.test.ts"], expect: "waiting" },
  // ---- Task 14: the fleet client, the fleet adapters and the repeat path (05-hub-fleet.md).
  { id: "t14-client-no-alert-event", task: "14", file: "apps/hub/src/adapters/fleet-client.ts",
    find: "const EVENTS = new Set<string>([\"inventory\", \"health\", \"status\", \"conflict\", \"alert\"]);",
    replace: "const EVENTS = new Set<string>([\"inventory\", \"health\", \"status\", \"conflict\"]);",
    run: ["apps/hub/test/fleet-client.test.ts"], expect: "not within 5000 ms" },
  { id: "t14-client-einval-reached", task: "14", file: "apps/hub/src/adapters/fleet-client.ts",
    find: ", \"EINVAL\", \"ENAMETOOLONG\"]);",
    replace: "]);",
    run: ["apps/hub/test/fleet-client.test.ts"], expect: "expected true to be false" },
  { id: "t14-client-no-name", task: "14", file: "apps/hub/src/adapters/fleet-client.ts",
    find: "const CLIENT = { \"x-morndo-client\": \"hub\" };",
    replace: "const CLIENT = {};",
    run: ["apps/hub/test/fleet-client.test.ts"], expect: "expected Set{ '' } to deeply equal Set{ 'hub' }" },
  { id: "t14-listing-waits", task: "14", file: "apps/hub/src/adapters/fleet-adapters.ts",
    find: "within(refreshInventory(node), LIMITS.inventoryWaitMs)",
    replace: "refreshInventory(node).catch(() => {})",
    run: ["apps/hub/test/fleet-adapters.test.ts"], expect: "to be less than 800" },
  { id: "t14-keys-uncertain-as-refused", task: "14", file: "apps/hub/src/adapters/fleet-adapters.ts",
    find: "return r.error.executed === \"maybe\" ? \"uncertain\" : false;",
    replace: "return false;",
    run: ["apps/hub/test/fleet-adapters.test.ts"], expect: "expected false to be 'uncertain'" },
  { id: "t14-unavailable-as-gone", task: "14", file: "apps/hub/src/adapters/fleet-adapters.ts",
    find: "    if (NOT_NOW.has(r.error.code)) throw new SourceUnavailable(`${op} on ${node}: ${r.error.code}`);\n",
    replace: "",
    run: ["apps/hub/test/fleet-adapters.test.ts"], expect: "promise resolved \"null\" instead of rejecting" },
  { id: "t14-http-keys-refused", task: "14", file: "apps/hub/src/adapters/http.ts",
    find: "      if (typed === \"uncertain\") send({ t: \"error\", error: \"keys_uncertain\" });\n      else if (!typed) send({ t: \"error\", error: \"keys_refused\" });",
    replace: "      if (!typed || typed === \"uncertain\") send({ t: \"error\", error: \"keys_refused\" });",
    run: ["apps/hub/test/http-terminal-throws.test.ts"], expect: "expected [ Array(1) ] to deeply equal [ Array(1) ]" },
  // The desktop with a fleet (spec §16.1): the PC holding both roles keeps its Desktop tab. Task 14's control pinned the
  // opposite ("no desktop in fleet mode"); the rollout to the PC reversed that rule, so this one guards the new one.
  { id: "rollout-fleet-desktop", task: "rollout", file: "apps/hub/src/main.ts",
    find: "      desktop: desktopTarget(config),",
    replace: "      desktop: fleet ? () => null : desktopTarget(config),",
    run: ["test/fleet/desktop.test.ts"], expect: "expected false to be true" },
  { id: "rollout-desktop-unset", task: "rollout", file: "apps/hub/src/adapters/local-ports.ts",
    find: "    if (!config.vnc) return null;",
    replace: "    if (!config.vnc) return { host: \"127.0.0.1\", port: 5900, password: null };",
    run: ["apps/hub/test/local-ports.test.ts"], expect: "to be null" },
  // Durability by failure domain (spec §16.4): the agent's database syncs no commit, the hub's says NORMAL from its first
  // open, and none of the three opens a database on a network file system.
  { id: "durability-agent-normal", task: "durability", file: "apps/node-agent/src/db/open.ts",
    find: "    db.pragma(\"synchronous = NORMAL\");",
    replace: "    db.pragma(\"synchronous = FULL\");",
    run: ["apps/node-agent/test/db.test.ts"], expect: "expected 2 to be 1" },
  { id: "durability-hub-normal", task: "durability", file: "apps/hub/src/adapters/store.ts",
    find: "    this.db.pragma(\"synchronous = NORMAL\");",
    replace: "    this.db.pragma(\"synchronous = FULL\");",
    run: ["apps/hub/test/store-durability.test.ts"], expect: "expected 2 to be 1" },
  { id: "durability-started-synced", task: "durability", file: "apps/node-agent/src/ops/done-keys.ts",
    find: "  db.pragma(\"synchronous = FULL\");\n  try { return transaction(); }",
    replace: "  try { return transaction(); }",
    run: ["apps/node-agent/test/done-keys.test.ts"], expect: "to deeply equal" },
  { id: "durability-agent-fullfsync", task: "durability", file: "apps/node-agent/src/db/open.ts",
    find: "    db.pragma(\"fullfsync = ON\");\n",
    replace: "",
    run: ["apps/node-agent/test/db.test.ts"], expect: "expected +0 to be 1" },
  { id: "durability-synced-not-nested", task: "durability", file: "apps/node-agent/src/ops/done-keys.ts",
    find: "  if (db.inTransaction) throw new Error(\"synced() runs its own transaction; it can't be nested in another\");\n",
    replace: "",
    run: ["apps/node-agent/test/done-keys.test.ts"], expect: "can't be nested" },
  { id: "durability-guard-network", task: "durability", file: "packages/service-kit/src/local-disk.ts",
    find: "  if (name !== undefined) {",
    replace: "  if (name !== undefined && false) {",
    run: ["packages/service-kit/test/service-kit.test.ts"], expect: "to throw an error" },
  { id: "durability-guard-agent", task: "durability", file: "apps/node-agent/src/db/open.ts",
    find: "  assertLocalDisk(dirname(path));\n",
    replace: "",
    run: ["apps/node-agent/test/db-local-disk.test.ts"], expect: "to throw an error" },
  { id: "durability-guard-fleet", task: "durability", file: "apps/fleet/src/adapters/db.ts",
    find: "  assertLocalDisk(dirname(path));\n",
    replace: "",
    run: ["apps/fleet/test/db-local-disk.test.ts"], expect: "to throw an error" },
  { id: "durability-guard-hub", task: "durability", file: "apps/hub/src/adapters/store.ts",
    find: "    assertLocalDisk(dataDir);",
    replace: "",
    run: ["apps/hub/test/store-local-disk.test.ts"], expect: "to throw an error" },
  { id: "t14-settle-hub-clock", task: "14", file: "apps/hub/src/application/steering-service.ts",
    find: "at: s.typedAt }; }",
    replace: "at: this.#now() }; }",
    run: ["apps/hub/test/fleet-steering.test.ts"], expect: "expected { ok: false, …(2) } to deeply equal { ok: false, …(2) }" },
  { id: "t14-unknown-never-trusted", task: "14", file: "apps/hub/src/application/steering-service.ts",
    find: "      this.#store.dropSend(key);\n      return null;",
    replace: "      return { ok: false, problem: \"uncertain\" };",
    run: ["apps/hub/test/fleet-steering.test.ts"], expect: "expected { ok: false, problem: 'uncertain' } to deeply equal { ok: true, at: 1791277200007 }" },
  { id: "t14-store-not-checked", task: "14", file: "apps/hub/src/application/steering-service.ts",
    find: "row.store === null || row.store !== s.store",
    replace: "false",
    run: ["apps/hub/test/fleet-steering.test.ts"], expect: "expected { ok: true, at: 1791277200007 } to deeply equal { ok: false, problem: 'uncertain' }" },
  { id: "t14-repeat-not-registered", task: "14", file: "apps/hub/src/application/steering-service.ts",
    find: "    this.#typing.set(key, job);\n",
    replace: "",
    run: ["apps/hub/test/fleet-steering.test.ts"], expect: "expected [ …(2) ] to deeply equal [ …(2) ]" },
  { id: "t14-manager-in-conflict", task: "14", file: "apps/hub/src/application/escalation-service.ts",
    find: "named.some(w => w.conflict) ? null : named[0]?.id ?? null",
    replace: "named[0]?.id ?? null",
    run: ["apps/hub/test/fleet-conflicts.test.ts"], expect: "to match object { ok: false, problem: 'lane_conflict' }" },
  { id: "t14-no-conflict-flags", task: "14", file: "apps/hub/src/adapters/fleet-adapters.ts",
    find: "conflict: view.conflicted(name),",
    replace: "conflict: false,",
    run: ["apps/hub/test/fleet-conflicts.test.ts"], expect: "expected false to be true" },
  { id: "t14-fleet-down-throws", task: "14", file: "apps/hub/src/application/observation-service.ts",
    find: "      if (!this.#nodeStates) throw e;",
    replace: "      throw e;",
    run: ["apps/hub/test/fleet-unavailable.test.ts"], expect: "connect ENOENT" },
  // ---- Task 15b: the offline marker, the fleet banner, keys "may have been typed", Check again (06-web-uncertain-offline.md).
  // The Chromium files need Chromium (npx playwright install chromium).
  { id: "t15b-check-new-id", task: "15b", file: "apps/web/src/lib/outbox/outbox.ts",
    find: "if (r.state === \"uncertain\") return this.#check(id);",
    replace: "if (r.state === \"uncertain\") { await this.discard(id); await this.enqueue({ worker: r.worker, workerName: r.workerName, text: r.text, uploads: r.uploads, seen: r.seen }); return; }",
    run: ["apps/web/test/outbox.test.ts", "apps/web/test/outbox-web.test.ts"], expect: "to deeply equal" },
  { id: "t15b-every-refusal-definite", task: "15b", file: "apps/web/src/lib/outbox/outbox.ts",
    find: "o.status === 409 || (o.status === 404 && o.code === \"no_pane\") || (o.status === 403 && o.code === \"step_up\");",
    replace: "true;",
    run: ["apps/web/test/outbox.test.ts", "apps/web/test/outbox-web.test.ts"], expect: "state: 'uncertain'" },
  { id: "t15b-check-blind-to-refusals", task: "15b", file: "apps/web/src/lib/outbox/outbox.ts",
    find: "    if (outcome.kind === \"refused\" && definiteRefusal(outcome)) {\n      await this.#save({ ...r, state: advance(r.state, \"failed\"), error: outcome.code });\n      return;\n    }\n",
    replace: "",
    run: ["apps/web/test/outbox.test.ts", "apps/web/test/outbox-web.test.ts"], expect: "state: 'failed'" },
  { id: "t15b-no-fleet-banner-wide", task: "15b", file: "apps/web/src/lib/desktop/Desktop.svelte",
    find: "  <FleetNotice available={feed.fleetAvailable} />\n",
    replace: "",
    run: ["apps/web/test/fleet-unavailable-web.test.ts"], expect: "Timeout 5000ms exceeded" },
  { id: "t15b-no-fleet-banner-narrow", task: "15b", file: "apps/web/src/lib/phone/Phone.svelte",
    find: "  <FleetNotice available={feed.fleetAvailable} />\n",
    replace: "",
    run: ["apps/web/test/fleet-unavailable-web.test.ts"], expect: "Timeout 5000ms exceeded" },
  { id: "t15b-no-fleet-frame-after-hello", task: "15b", file: "apps/hub/src/adapters/http.ts",
    find: "            send({ t: \"fleet\", available: observation.fleet() === \"ok\" });   // a resumed feed may have missed a change\n",
    replace: "",
    run: ["apps/hub/test/feed-fleet.test.ts"], expect: "expected [] to deeply equal [ true ]" },
  { id: "t15b-no-fleet-frame-on-change", task: "15b", file: "apps/hub/src/adapters/http.ts",
    find: "        fleet: status => send({ t: \"fleet\", available: status === \"ok\" }),\n",
    replace: "",
    run: ["apps/hub/test/feed-fleet.test.ts"], expect: "expected false to be true" },
  { id: "t15b-keys-one-wording", task: "15b", file: "apps/web/src/lib/desktop/TerminalView.svelte",
    find: "note = m.error === \"keys_uncertain\" ? \"Those keys may have been typed.\" : \"The pane didn't take those keys.\"; break;",
    replace: "note = \"The pane didn't take those keys.\"; break;",
    run: ["apps/web/test/terminal-keys-web.test.ts"], expect: "to be 'Those keys may have been typed.'" },
  { id: "t15b-no-refusal-words", task: "15b", file: "apps/web/src/lib/desktop/decisions.ts",
    find: "  lane_conflict: \"Two windows are named like the manager, so the answer wasn't typed: nobody can tell which one it's for. Close or rename one of them, then try again.\",\n",
    replace: "",
    run: ["apps/web/test/decision-refusals.test.ts"], expect: "expected [ 'lane_conflict' ] to deeply equal []" },
  { id: "t15b-no-offline-marker-wide", task: "15b", file: "apps/web/src/lib/desktop/Sidebar.svelte",
    find: "              {#if w.offline}<span class=\"off\">offline</span>{/if}\n",
    replace: "",
    run: ["apps/web/test/worker-offline-web.test.ts"], expect: "expected 'alpha' to contain 'offline'" },
  { id: "t15b-no-offline-marker-narrow", task: "15b", file: "apps/web/src/lib/phone/Agents.svelte",
    find: "{#if w.offline}<span class=\"when muted\">offline</span>\n            {:else if w.needsYou}",
    replace: "{#if w.needsYou}",
    run: ["apps/web/test/worker-offline-web.test.ts"], expect: "to be 'offline'" },
  // ---- Review fixes: the guards the review rounds added (Task 18b's ruling 2), each with the control its report names.
  { id: "t1-unknown-code-maybe", task: "1", file: "packages/protocol/src/fleet.ts",
    find: `: { code: "internal", executed: "maybe", message };`,
    replace: `: { code: "internal", executed, message };`,
    run: ["packages/protocol/test/fleet.test.ts"], expect: "expected { code: 'internal', …(2) } to deeply equal" },
  { id: "t2-confine-case-fold", task: "2", file: "packages/node-ops/src/file-rules.ts",
    find: "const fold = (p: string) => (caseless ? p.toLowerCase() : p);", replace: "const fold = (p: string) => p;",
    run: ["packages/node-ops/test/file-rules.test.ts"], expect: ".SSH/absent" },
  // Since B1 (V23 keeps a legacy answer's row) a retry by the same request is settled by its row; this bites through the
  // new tap after the restart (another request), which finds the answer in doubt by its key alone.
  { id: "t5-first-seen-restart", task: "5", file: "apps/hub/src/application/escalation-service.ts",
    find: "    this.#firstSeen = this.#store.askFirstSeen();\n", replace: "",
    run: ["apps/hub/test/escalation-answer-keys.test.ts"], expect: "to have a length of 1" },
  { id: "t5-menu-kept-unread", task: "5", file: "apps/hub/src/application/escalation-service.ts",
    find: "      } else if (read !== undefined) {", replace: "      } else {",
    run: ["apps/hub/test/escalation-answer-keys.test.ts"] },
  { id: "t9-full-coalesce-rolls-back", task: "9", file: "apps/node-agent/src/relay/spool.ts",
    find: "        if (full() && coalesce !== null) throw new Refused();",
    replace: "        if (full() && coalesce !== null) return { appended: { ok: false, why: \"full\" }, count, bytes };",
    run: ["apps/node-agent/test/spool.test.ts"] },
  { id: "t9-full-eviction-rolls-back", task: "9", file: "apps/node-agent/src/relay/spool.ts",
    find: "          if (!victim) throw new Refused();",
    replace: "          if (!victim) return { appended: { ok: false, why: \"full\" }, count, bytes };",
    run: ["apps/node-agent/test/spool.test.ts"] },
  { id: "t11-revoked-during-instance-check", task: "11", file: "apps/fleet/src/application/connections.ts",
    find: "    if (!this.#nodes.active(a.node)) return { ok: false, revoked: true };\n", replace: "",
    run: ["apps/fleet/test/instances.test.ts"] },
  { id: "t11-frames-after-fleet-close", task: "11", file: "apps/fleet/src/adapters/agent-session.ts",
    find: "send, ping: () => ws.ping(), close: closeFromFleet,",
    replace: "send, ping: () => ws.ping(), close: (code, reason) => ws.close(code, reason),",
    run: ["apps/fleet/test/agent-auth.test.ts"] },
  { id: "t11-revoked-between-challenge-and-proof", task: "11", file: "apps/fleet/src/adapters/agent-session.ts",
    find: "        if (!row) { refused(hello.node, \"unknown_node\"); return close(CLOSE.forbidden, \"unknown or revoked node\"); }\n", replace: "",
    run: ["apps/fleet/test/agent-auth.test.ts"] },
  { id: "t11-close-grace-terminate", task: "11", file: "apps/fleet/src/adapters/agent-session.ts",
    find: "    grace ??= setTimeout(() => ws.terminate(), CLOSE_GRACE_MS);",
    replace: "    grace ??= setTimeout(() => {}, CLOSE_GRACE_MS);",
    run: ["apps/fleet/test/agent-auth.test.ts"] },
  { id: "t12-file-shrank", task: "12", file: "apps/fleet/src/adapters/files-route.ts",
    find: "      if (offset !== size) { res.destroy(", replace: "      if (false) { res.destroy(",
    run: ["apps/fleet/test/client-api.test.ts"] },
  { id: "t12-file-grew", task: "12", file: "apps/fleet/src/adapters/files-route.ts",
    find: "    if (offset > size) { res.destroy(", replace: "    if (false) { res.destroy(",
    run: ["apps/fleet/test/client-api.test.ts"] },
  { id: "t12-file-midstream-failure", task: "12", file: "apps/fleet/src/adapters/files-route.ts",
    find: "    if (!got.ok) { res.destroy(new Error(`file.get failed: ${got.error.code}`)); return; }",
    replace: "    if (!got.ok) { res.end(); return; }",
    run: ["apps/fleet/test/client-api.test.ts"] },
  // The socket is also checked, later, where the client API listens (client-api.ts); this removes the early check only.
  { id: "t12-socket-checked-before-db", task: "12", file: "apps/fleet/src/serve.ts",
    find: "  await clearStaleSocket(config.socketPath);        // a live service owns fleet.db: refuse before touching it\n", replace: "",
    run: ["apps/fleet/test/socket-dir.test.ts"] },
  { id: "t14a-file-short-body", task: "14a", file: "apps/hub/src/adapters/fleet-client.ts",
    find: "      if (got !== expected) throw new FleetUnavailable(", replace: "      if (false) throw new FleetUnavailable(",
    run: ["apps/hub/test/fleet-client.test.ts"], expect: "to be an instance of FleetUnavailable" },
  { id: "t14a-file-overrun", task: "14a", file: "apps/hub/src/adapters/fleet-client.ts",
    find: "          if (got > expected) throw new FleetMismatch(", replace: "          if (false) throw new FleetMismatch(",
    run: ["apps/hub/test/fleet-client.test.ts"] },
  { id: "t14a-file-size-header", task: "14a", file: "apps/hub/src/adapters/fleet-client.ts",
    find: "      if (!Number.isSafeInteger(expected) || expected < 0) throw new FleetMismatch(",
    replace: "      if (false) throw new FleetMismatch(",
    run: ["apps/hub/test/fleet-client.test.ts"] },
  { id: "t14a-file-midstream-failure", task: "14a", file: "apps/hub/src/adapters/fleet-client.ts",
    find: "        throw new FleetUnavailable(`GET /v1/files: ${(e as Error).message}`, true, { cause: e });",
    replace: "        throw e;",
    run: ["apps/hub/test/fleet-client.test.ts"], expect: "to be an instance of FleetUnavailable" },
  { id: "t14a-5xx-not-op", task: "14a", file: "apps/hub/src/adapters/fleet-client.ts",
    find: "          if ((res.statusCode ?? 200) >= 500 && path !== \"/v1/op\") {", replace: "          if (false) {",
    run: ["apps/hub/test/fleet-client.test.ts"] },
  { id: "t14a-op-malformed-in-doubt", task: "14a", file: "apps/hub/src/adapters/fleet-client.ts",
    find: "    throw new FleetUnavailable(`POST /v1/op ${op}: not an op answer`, true);",
    replace: "    throw new FleetMismatch(`POST /v1/op ${op}: not an op answer`);",
    run: ["apps/hub/test/fleet-client.test.ts"] },
  { id: "t14a-op-non-json-in-doubt", task: "14a", file: "apps/hub/src/adapters/fleet-client.ts",
    find: "      if (e instanceof FleetMismatch) throw new FleetUnavailable(e.message, true, { cause: e });",
    replace: "      if (e instanceof FleetMismatch) throw e;",
    run: ["apps/hub/test/fleet-client.test.ts"], expect: "to be an instance of FleetUnavailable" },
  { id: "t14b-events-on-open-resync", task: "14b", file: "apps/hub/src/adapters/fleet-adapters.ts",
    find: "client.events(e => view.apply(e), { onOpen: resync });", replace: "client.events(e => view.apply(e));",
    run: ["apps/hub/test/fleet-adapters.test.ts"], expect: "not within 5000 ms" },
  { id: "t14c-send-unreached-refused", task: "14c", file: "apps/hub/src/adapters/fleet-adapters.ts",
    find: "        if (e instanceof FleetUnavailable && !e.reached) return refused(\"node_offline\");",
    replace: "        if (e instanceof FleetUnavailable && !e.reached) throw new SendInDoubt(null, \"control\");",
    run: ["apps/hub/test/fleet-adapters.test.ts"] },
  { id: "t14c-send-unanswered-in-doubt", task: "14c", file: "apps/hub/src/adapters/fleet-adapters.ts",
    find: "        if (e instanceof FleetUnavailable) throw new SendInDoubt(null, `pane.send to ${id}: ${e.message}`, { cause: e });",
    replace: "        if (e instanceof FleetUnavailable) return refused(\"node_offline\");",
    run: ["apps/hub/test/fleet-adapters.test.ts"], expect: "to be an instance of SendInDoubt" },
  { id: "t14c-send-unknown-answer-in-doubt", task: "14c", file: "apps/hub/src/adapters/fleet-adapters.ts",
    find: "        throw new SendInDoubt(r.store, \"pane.send: an answer this hub doesn't know\", { storeSeq: r.storeSeq });",
    replace: "        return refused(\"busy\");",
    run: ["apps/hub/test/fleet-adapters.test.ts"], expect: "to be an instance of SendInDoubt" },
  { id: "t16b-clean-env-claude", task: "16b", file: "test/fleet-harness.ts",
    find: "|CLAUDE|TMUX$|TMUX_PANE$", replace: "|CLAUDE_CONFIG_DIR$|TMUX$|TMUX_PANE$",
    run: ["test/fleet/harness.test.ts"], expect: "to deeply equal []" },
  { id: "t16b-stopall-removes-sockets", task: "16b", file: "test/fleet-harness.ts",
    find: "  servers.set(t.socket, () => t.kill());",
    replace: "  servers.set(t.socket, () => { spawnSync(\"tmux\", [\"-L\", t.socket, \"kill-server\"], { env: tmuxEnv() }); });",
    run: ["test/fleet/harness.test.ts"], expect: "expected true to be false" },
  { id: "t16b-fleet-fails-fast", task: "16b", file: "test/fleet-harness.ts",
    find: "      if (!p.alive()) throw new Fatal(`the fleet exited during startup (${p.child.exitCode ?? p.child.signalCode})\\n${p.tail(15)}`);\n",
    replace: "",
    run: ["test/fleet/harness.test.ts"] },
  { id: "t17-stopall-recreated-server", task: "17", file: "test/fleet-harness.ts",
    find: "    kill: () => { t.kill(); },   // stays registered: a server recreated on this socket is stopped by stopAll too",
    replace: "    kill: () => { servers.delete(t.socket); t.kill(); },",
    run: ["test/fleet/drills-nodes.test.ts", "test/fleet/harness.test.ts"] },
  // ---- The final review's fix wave (lanes FA and FB) and its follow-up (final-review.md; fixwave-FA/FB-report.md): one
  // entry per guard it added, each with the test that must notice it gone.
  { id: "fw-c1-answer-not-settled", task: "C1", file: "apps/hub/src/application/escalation-service.ts",
    find: "await this.#settle(row.key, row.workerId)", replace: "null",
    run: ["apps/hub/test/escalation-in-doubt.test.ts"] },
  { id: "fw-i1-in-doubt-thrown", task: "I1", file: "apps/hub/src/application/steering-service.ts",
    find: "      log.warn(`send to ${workerId} in doubt: its node may have typed it; a repeat asks the node`, e);\n      return { ok: false, problem: \"uncertain\" };",
    replace: "      log.warn(`send to ${workerId} in doubt: its node may have typed it; a repeat asks the node`, e);\n      throw e;",
    run: ["apps/hub/test/fleet-steering.test.ts"] },
  { id: "fw-i2-file-identity-ignored", task: "I2", file: "apps/node-agent/src/db/open.ts",
    find: "    if (recorded?.value === identity) return { streamId: row.value, copied: false };",
    replace: "    if (true) return { streamId: row.value, copied: false };",
    run: ["apps/node-agent/test/db.test.ts", "apps/node-agent/test/agent.test.ts"] },
  { id: "fw-a-store-seq-not-compared", task: "A", file: "apps/hub/src/application/steering-service.ts",
    find: "      if (row.storeSeq !== null && s.storeSeq !== null && s.storeSeq < row.storeSeq) {", replace: "      if (false) {",
    run: ["apps/hub/test/fleet-steering.test.ts", "apps/hub/test/escalation-in-doubt.test.ts"] },
  { id: "fw-a-store-seq-not-counted", task: "A", file: "apps/node-agent/src/ops/done-keys.ts",
    find: "      return (this.#db.prepare(\"UPDATE store_seq SET seq = seq + 1 WHERE one = 1 RETURNING seq\").get() as { seq: number }).seq;",
    replace: "      return this.#seq;",
    run: ["apps/node-agent/test/done-keys.test.ts", "apps/node-agent/test/agent.test.ts"] },
  { id: "fw-a-fleet-own-answer-no-seq", task: "A", file: "apps/fleet/src/application/requests.ts",
    find: "        const seq = this.highestSeq(ch.node, ch.store);", replace: "        const seq = null;",
    run: ["apps/fleet/test/requests.test.ts"] },
  { id: "fw-i3-unrouted-not-counted", task: "I3", file: "apps/fleet/src/adapters/outbox-store.ts",
    find: "        if (subscribers.length === 0) { unrouted.set(e.path, (unrouted.get(e.path) ?? 0) + 1); continue; }",
    replace: "        if (subscribers.length === 0) continue;",
    run: ["apps/fleet/test/hook-intake.test.ts", "apps/fleet/test/status.test.ts"] },
  { id: "fw-m1-refusal-row-kept", task: "M1", file: "apps/hub/src/application/steering-service.ts",
    find: "BEFORE_PASTE.has(problem) || REFUSED.has(problem)", replace: "BEFORE_PASTE.has(problem)",
    run: ["apps/hub/test/fleet-steering.test.ts"] },
  { id: "fw-m1-internal-no-in-doubt", task: "M1", file: "apps/hub/src/application/ports.ts",
    find: "\"unknown_op\", \"internal\", \"name_taken\"", replace: "\"unknown_op\", \"name_taken\"",
    run: ["apps/hub/test/fleet-steering.test.ts", "apps/hub/test/escalation-in-doubt.test.ts"] },
  { id: "fw-m2-credential-files", task: "M2", file: "packages/node-ops/src/file-rules.ts",
    find: String.raw`\.pgpass|\.git-credentials|\.claude\.json(\..+)?|credentials\.toml|`, replace: "",
    run: ["packages/node-ops/test/file-rules.test.ts"] },
  { id: "fw-m3-agent-db-unreadable-exit", task: "M3", file: "apps/node-agent/src/main.ts",
    find: "      if (e instanceof ConfigError || e instanceof DatabaseUnreadable || e instanceof NotLocalDisk) {", replace: "      if (e instanceof ConfigError || e instanceof NotLocalDisk) {",
    run: ["apps/node-agent/test/agent.test.ts"] },
  { id: "fw-t10-fleet-db-written-first", task: "T10", file: "apps/fleet/src/adapters/db.ts",
    find: "  refuseBeforeWriting(path);\n", replace: "",
    run: ["apps/fleet/test/startup-files.test.ts"] },
  { id: "fw-t10-fleet-key-corrupt-raw", task: "T10", file: "apps/fleet/src/adapters/keys.ts",
    find: "  catch { throw new KeyFileUnreadable(`${path} is not a readable private key (corrupt or half written); restore the fleet's key there (every node pins it)`); }",
    replace: "  catch (e) { throw e; }",
    run: ["apps/fleet/test/startup-files.test.ts"] },
  { id: "fw-t13-delivery-round-throws", task: "T13", file: "apps/fleet/src/application/delivery.ts",
    find: "    try { f(); } catch (e) { this.#log.error(`hook bus: ${what} failed (fleet.db busy or full?); trying again later`, e); }",
    replace: "    f();",
    run: ["apps/fleet/test/timers.test.ts"] },
  { id: "fw-m4-sweep-seen-throws", task: "M4", file: "apps/fleet/src/application/connections.ts",
    find: "      try { this.#nodes.seen(node); } catch (e) { this.#log.error(`liveness sweep: could not record node ${node} as seen (fleet.db busy or full?)`, e); }",
    replace: "      this.#nodes.seen(node);",
    run: ["apps/fleet/test/timers.test.ts"], expect: "expected 0 to be greater than 0" },
  { id: "fw-m5-unavailable-frame-gone", task: "M5", file: "apps/hub/src/adapters/fleet-adapters.ts",
    find: "      if (NOT_NOW.has(r.error.code)) return \"unavailable\";", replace: "      if (NOT_NOW.has(r.error.code)) return null;",
    run: ["apps/hub/test/fleet-adapters.test.ts"] },
  { id: "fw-m5-view-closed-when-unavailable", task: "M5", file: "apps/hub/src/adapters/http.ts",
    find: "        if (f === \"unavailable\") {                         // its node can't answer now: kept open, asked again later (M5)",
    replace: "        if (f === \"unavailable\") { ws.close(4404, \"pane gone\"); return;",
    run: ["apps/hub/test/http-terminal-throws.test.ts"] },
  { id: "fw-e-frames-no-backoff", task: "E", file: "apps/hub/src/adapters/http.ts",
    find: "          askAt = performance.now() + backoff;", replace: "          askAt = 0;",
    run: ["apps/hub/test/http-terminal-throws.test.ts"], expect: "to be less than or equal to 6" },
  { id: "fw-m6-keys-failure-maybe", task: "M6", file: "apps/node-agent/src/ops/executor.ts",
    find: "return { ok: false, error: { code: \"internal\", executed: \"no\", message: \"the node could not record the op's key (a full disk?); nothing was run\" } };",
    replace: "return { ok: false, error: { code: \"internal\", executed: \"maybe\", message: \"the node could not record the op's key (a full disk?); nothing was run\" } };",
    run: ["apps/node-agent/test/executor.test.ts"] },
  { id: "fw-m7-args-not-checked", task: "M7", file: "apps/fleet/src/application/router.ts",
    find: "    const checked = parseBody(OP_ARGS[op], a) as Record<string, unknown> | null;",
    replace: "    const checked = a as Record<string, unknown> | null;",
    run: ["apps/fleet/test/router.test.ts"] },
  { id: "fw-m10-deny-roots-unresolved", task: "M10", file: "apps/node-agent/src/ops/lane-ops.ts",
    find: "  const deny = () => resolvedRoots(denyRoots(d.home, d.stateDir, denyConfigFromEnv(process.env)));", replace: "  const deny = () => denyRoots(d.home, d.stateDir, denyConfigFromEnv(process.env));",
    run: ["apps/node-agent/test/lane-worktree-ops.test.ts"] },
  { id: "fw-t8-locked-panes-prototype", task: "T8", file: "apps/node-agent/src/ops/pane-ops.ts",
    find: "Object.hasOwn(d.policy.lockedPanes, exp.window) ? d.policy.lockedPanes[exp.window] : undefined",
    replace: "d.policy.lockedPanes[exp.window]",
    run: ["apps/node-agent/test/pane-ops.test.ts"] },
  { id: "fw-t11-challenge-unknown-node", task: "T11", file: "apps/fleet/src/adapters/agent-session.ts",
    find: "        if (!d.nodes.active(m.node)) { refused(m.node, \"unknown_node\"); return close(CLOSE.forbidden, \"unknown or revoked node\"); }\n",
    replace: "",
    run: ["apps/fleet/test/agent-auth.test.ts"] },
  { id: "fw-14c-relative-socket-served", task: "14c", file: "apps/hub/src/main.ts",
    find: "    if (config.fleetSocket && !fleetSocketOk(config.fleetSocket)) {", replace: "    if (false) {",
    run: ["apps/hub/test/config-fleet.test.ts"] },
  { id: "fw-welcome-store-behind-ignored", task: "A2", file: "apps/node-agent/src/agent.ts",
    find: "    const storeBehind = w.storeSeqSeen !== undefined && seq < w.storeSeqSeen;", replace: "    const storeBehind = false;",
    run: ["apps/node-agent/test/agent.test.ts"], expect: "starts a new store before it runs anything" },
  { id: "fw-welcome-store-seq-not-sent", task: "A2", file: "apps/fleet/src/adapters/agent-session.ts",
    find: "...(seen === null ? {} : { storeSeqSeen: seen })", replace: "",
    run: ["apps/fleet/test/requests.test.ts"], expect: "storeSeqSeen" },
  { id: "fw-store-seqs-not-kept", task: "A2", file: "apps/fleet/src/application/requests.ts",
    find: "    if (res.storeSeq !== undefined) this.#seqs.saw(node, res.store, res.storeSeq);\n", replace: "",
    run: ["apps/fleet/test/requests.test.ts"] },
  { id: "fw-b-answer-row-after-typing", task: "B", file: "apps/hub/src/application/escalation-service.ts",
    find: "      if (!this.#store.startAnswer(k, now, { workerId: e.asker.workerId, request })) return { ok: false, problem: \"uncertain\", item: this.#view(id) };\n",
    replace: "",
    run: ["apps/hub/test/escalation-in-doubt.test.ts"] },
  // The fix wave's guards its re-review found without a control, and the residual round's (residual-round-report.md).
  { id: "fw-m1-answer-refusal-row-kept", task: "M1", file: "apps/hub/src/application/steering-service.ts",
    find: "if (nothingTyped(outcome.problem)) store.dropSend(key);", replace: "if (false) store.dropSend(key);",
    run: ["apps/hub/test/escalation-in-doubt.test.ts"], expect: "a definite refusal of an answer" },
  { id: "adr8-answer-not-submitted-row-dropped", task: "ADR-0008", file: "apps/hub/src/application/steering-service.ts",
    find: "if (nothingTyped(outcome.problem)) store.dropSend(key);", replace: "store.dropSend(key);",
    run: ["apps/hub/test/escalation-in-doubt.test.ts"], expect: "not_submitted keeps its row: a repeat of the same option is uncertain" },
  { id: "fw-i1-answer-in-doubt-thrown", task: "I1", file: "apps/hub/src/application/escalation-service.ts",
    find: "        log.warn(`answer to ${e.id} in doubt: its node may have typed it; a repeat asks the node`, err);\n        return { ok: false, problem: \"uncertain\", item: this.#view(id) };",
    replace: "        log.warn(`answer to ${e.id} in doubt: its node may have typed it; a repeat asks the node`, err);\n        throw err;",
    run: ["apps/hub/test/escalation-in-doubt.test.ts"], expect: "an answer in doubt is settled with its node" },
  { id: "fw-i3-unrouted-alerted-again", task: "I3", file: "apps/fleet/src/application/hook-intake.ts",
    find: " || this.#unroutedAlerted.has(path)) continue;", replace: ") continue;",
    run: ["apps/fleet/test/hook-intake.test.ts"], expect: "the first of each script path raises one alert" },
  { id: "rr2-identity-device-compared", task: "R2", file: "apps/node-agent/src/db/open.ts",
    find: "inodeOf(recorded.value) === inodeOf(identity)", replace: "recorded.value === identity",
    run: ["apps/node-agent/test/db.test.ts"], expect: "only the inode is compared" },
  { id: "rr3-hub-files-roots-unresolved", task: "R3", file: "apps/hub/src/adapters/files.ts",
    find: "deniedBy(real, resolvedRoots(opts.deny))", replace: "deniedBy(real, opts.deny)",
    run: ["apps/hub/test/files.test.ts"], expect: "HOME behind a symbolic link" },
  { id: "rr4-welcome-last-seq-throw-admits", task: "R4", file: "apps/node-agent/src/agent.ts",
    find: "log.warn(\"could not read the hook stream's last seq; the store sequence still decides\", e); last = null; }",
    replace: "log.warn(\"could not read the hook stream's last seq; the store sequence still decides\", e); return false; }",
    run: ["apps/node-agent/test/agent.test.ts"], expect: "even when the stream's last seq can't be read" },
  { id: "rr5-store-seqs-read-outside-try", task: "R5", file: "apps/fleet/src/adapters/store-seqs.ts",
    find: "    try { known = this.#cached(k, node, store); }", replace: "    known = this.#cached(k, node, store); try { /* the read outside it */ }",
    run: ["apps/fleet/test/store-seqs.test.ts"], expect: "a read fleet.db refuses" },
  { id: "rr5-store-seqs-unread-remembered", task: "R5", file: "apps/fleet/src/adapters/store-seqs.ts",
    find: "    if (read) this.#remember(k, seq);", replace: "    this.#remember(k, seq);",
    run: ["apps/fleet/test/store-seqs.test.ts"], expect: "a read fleet.db refuses" },
  // ---- PR #12 review, batch B6 (fleet; .keryx/validations/sections/B6.md): one entry per guard its fixes add, each
  // with the test that must notice it gone.
  { id: "b6-s1-close-all-at-once", task: "B6", file: "apps/fleet/src/adapters/client-api.ts",
    find: "      server.closeIdleConnections();\n    }),",
    replace: "      server.closeAllConnections();\n    }),",
    run: ["apps/fleet/test/shutdown-drain.test.ts"], expect: "socket hang up" },
  { id: "b6-v21-audit-throw-replaces-outcome", task: "B6", file: "apps/fleet/src/application/router.ts",
    find: "    try { this.#audit.record(\"client\", `op.${op}`, node, detail); }\n    catch (e) {",
    replace: "    this.#audit.record(\"client\", `op.${op}`, node, detail);\n    if (false) (e: unknown) => {",
    run: ["apps/fleet/test/audit-failure.test.ts"], expect: "expected 500 to be 200" },
  { id: "b6-v39-no-store-failure-hold", task: "B6", file: "apps/fleet/src/application/delivery.ts",
    find: " || this.#held(k)) return false;",
    replace: ") return false;",
    run: ["apps/fleet/test/delivery-store-failure.test.ts"], expect: "to be less than or equal to 4" },
  { id: "b6-v40-route-closing-socket", task: "B6", file: "apps/fleet/src/application/connections.ts",
    find: "    if (!c.peer.open()) return Promise.resolve(failed(\"node_offline\"",
    replace: "    if (false) return Promise.resolve(failed(\"node_offline\"",
    run: ["apps/fleet/test/closing-socket.test.ts"], expect: "node_offline" },
  { id: "b6-v41-remove-before-writes", task: "B6", file: "apps/fleet/src/application/connections.ts",
    find: "    const epoch = this.#nodes.nextEpoch(a.node);\n",
    replace: "    const gone = this.#live.get(a.node);\n    if (gone) { this.#live.delete(a.node); this.#answered(gone, false); if (gone.instanceId === a.instanceId) gone.peer.close(REPLACED, \"replaced\"); else gone.peer.terminate(); }\n    const epoch = this.#nodes.nextEpoch(a.node);\n",
    run: ["apps/fleet/test/admission-failure.test.ts"], expect: "expected false to be true" },
  { id: "b6-v42-last-round-continue", task: "B6", file: "apps/fleet/src/application/connections.ts",
    find: "        return this.#admitNow(a, welcome);\n      }\n      if (!cur.refusedAlerted",
    replace: "        this.#live.delete(a.node);\n        cur.peer.terminate();\n        continue;\n      }\n      if (!cur.refusedAlerted",
    run: ["apps/fleet/test/instance-rounds.test.ts"], expect: "expected false to be true" },
  { id: "b6-ef1-next-walks-kept-rows", task: "B6", file: "apps/fleet/src/adapters/outbox-store.ts",
    find: "AND o.seq >= ? AND d.state = 'pending' ORDER BY o.seq LIMIT 1`)\n      .get(subscriber, node, streamId, fromSeq)",
    replace: "AND ? >= 0 AND d.state = 'pending' ORDER BY o.seq LIMIT 1`)\n      .get(subscriber, node, streamId, fromSeq)",
    run: ["apps/fleet/test/outbox-seek.test.ts"], expect: "to be less than 5" },
  { id: "b6-ef2-no-floors", task: "B6", file: "apps/fleet/src/application/delivery.ts",
    find: "this.#store.heads(s.name, this.#floorsOf(s.name))",
    replace: "this.#store.heads(s.name)",
    run: ["apps/fleet/test/delivery-round.test.ts"], expect: "to be less than 5" },
  { id: "b6-ef3-search-from-start", task: "B6", file: "apps/fleet/src/adapters/outbox-store.ts",
    find: "              b.after = id;                                // none pending up to this row; later ones come above it\n",
    replace: "",
    run: ["apps/fleet/test/backlog-cap.test.ts"], expect: "to be less than 500" },
  // ---- keryx B4 (agent tmux and ops): the validated plan's controls, one per guard.
  { id: "b4-list-panes-absent-only", task: "b4", file: "apps/node-agent/src/ops/tmux-panes.ts",
    find: 'if (tmuxFailure(e) === "absent") return [];\n    throw new TmuxUnavailable("tmux list-panes did not answer", { cause: e });',
    replace: "return [];",
    run: ["apps/node-agent/test/inventory-tmux-stall.test.ts"], expect: "promise resolved" },
  { id: "b4-frame-unavailable-is-timeout", task: "b4", file: "apps/node-agent/src/ops/pane-ops.ts",
    find: 'if (frame === "unavailable") return fail("timeout", "tmux did not answer: no frame now");',
    replace: 'if (frame === "unavailable") return ok<"pane.frame">({ frame: null });',
    run: ["apps/node-agent/test/pane-frame-unavailable.test.ts"], expect: "timeout" },
  { id: "b4-tmux-literal-trailing-semicolon", task: "b4", file: "packages/node-ops/src/tmux-cli.ts",
    find: 'return doubled.endsWith(";") ? `${doubled.slice(0, -1)}\\\\;` : doubled;', replace: "return doubled;",
    run: ["packages/node-ops/test/tmux-cli.test.ts"], expect: "review;" },
  { id: "b4-paste-spawn-timeout", task: "b4", file: "packages/node-ops/src/tmux.ts",
    find: ', { timeout: 5000, killSignal: "SIGKILL" });\n        p.on("error", reject);', replace: ');\n        p.on("error", reject);',
    run: ["apps/node-agent/test/pane-ops.test.ts"], expect: "stalls at the paste" },
  { id: "b4-paste-deadline-last-word", task: "b4", file: "packages/node-ops/src/tmux.ts",
    find: "call?.signal?.throwIfAborted();", replace: "",
    run: ["apps/node-agent/test/pane-ops.test.ts"], expect: "outlasts the deadline" },
  { id: "b4-session-version-bounded", task: "b4", file: "packages/node-ops/src/sessions.ts",
    find: "typeof d.version === \"string\" && VERSION.test(d.version) ? d.version : null", replace: "typeof d.version === \"string\" ? d.version : null",
    run: ["packages/node-ops/test/sessions.test.ts"], expect: "keeps a normal version" },
  { id: "b4-worktree-deny-roots", task: "b4", file: "apps/node-agent/src/ops/worktree-ops.ts",
    find: " && !deniedBy(real, deny()) ? real : null;", replace: " ? real : null;",
    run: ["apps/node-agent/test/lane-worktree-ops.test.ts"], expect: "deny root" },
  { id: "b4-paste-killed-late-in-doubt", task: "b4", file: "apps/node-agent/src/ops/pane-ops.ts",
    find: 'if (signal.aborted && e === signal.reason) return fail("timeout", "the deadline passed before the paste");',
    replace: 'if (signal.aborted) return fail("timeout", "the deadline passed before the paste");',
    run: ["apps/node-agent/test/pane-ops.test.ts"], expect: "stays in doubt" },
  { id: "b1-v38-settled-send-not-audited", task: "B1-V38", file: "apps/hub/src/application/steering-service.ts",
    find: "typedThere(s.typedAt); ", replace: "",
    run: ["apps/hub/test/fleet-steering.test.ts"], expect: "a send found typed there is audited then" },
  { id: "b1-v23-legacy-throw-row-dropped", task: "B1-V23", file: "apps/hub/src/application/escalation-service.ts",
    find: "          log.warn(`answer to ${e.id} in doubt: typing it threw, maybe after the paste; a repeat stays uncertain`, err);\n          return { ok: false, problem: \"uncertain\", item: this.#view(id) };",
    replace: "          this.#store.dropSend(k);\n          throw err;",
    run: ["apps/hub/test/escalation-in-doubt.test.ts", "apps/hub/test/escalation-answer-keys.test.ts"], expect: "a throw while typing keeps its row" },
  // ---- B1 validation (answers and doubt): E8 while an answer is in doubt, and the card that keeps the doubt.
  { id: "b1-v7-other-answer-not-settled", task: "B1-V7", file: "apps/hub/src/application/escalation-service.ts",
    find: "      const other = await this.#otherAnswer(a, id, askPrefix(e.id, e), k);\n      if (other) return other;\n", replace: "",
    run: ["apps/hub/test/escalation-in-doubt.test.ts"], expect: "another answer to the same ask while one is in doubt" },
  { id: "b1-v7-typed-earlier-not-recorded", task: "B1-V7", file: "apps/hub/src/application/escalation-service.ts",
    find: "        this.#typedEarlier(a, id, other.key.slice(prefix.length));\n", replace: "",
    run: ["apps/hub/test/escalation-in-doubt.test.ts"], expect: "the first recorded once" },
  { id: "b1-v7-every-refusal-ends-doubt", task: "B1-V7", file: "apps/web/src/lib/catchup/answer.ts",
    find: "Object.hasOwn(REFUSALS, code) && !STILL_IN_DOUBT.has(code)", replace: "true",
    run: ["apps/web/test/catchup-answer.test.ts"], expect: "keeps the doubt on no answer" },
  { id: "b1-v7-card-drops-doubt", task: "B1-V7", file: "apps/web/src/lib/desktop/DecisionCard.svelte",
    find: " : doubt && !endsDoubt(problem.code) ? doubt : null;", replace: " : null;",
    run: ["apps/web/test/answer-in-doubt-web.test.ts"], expect: "still Check again on the same request id" },
  { id: "b1-v8-check-again-drops-doubt", task: "B1-V8", file: "apps/web/src/lib/phone/quick.ts",
    find: "(f.retry?.requestId === a.requestId || f.again?.requestId === a.requestId)", replace: "false",
    run: ["apps/web/test/quick.test.ts"], expect: "keeps the doubt until it is settled" },
  { id: "b1-v8-confirm-new-request-id", task: "B1-V8", file: "apps/web/src/lib/phone/Today.svelte",
    find: "quick.answer(a.id, a.body, a.label, a.seen, a.requestId);", replace: "quick.answer(a.id, a.body, a.label, a.seen);",
    run: ["apps/web/test/today-check-again-web.test.ts"], expect: "the confirm sends the same request id" },
  { id: "b1-v14-not-submitted-definite", task: "B1-V14", file: "apps/web/src/lib/outbox/outbox.ts",
    find: "byStatus(o) && !afterPaste(o)", replace: "byStatus(o)",
    run: ["apps/web/test/outbox.test.ts"], expect: "Check again answered 409 not_submitted leaves it Uncertain" },
  { id: "b1-v14-first-not-submitted-not-sent", task: "B1-V14", file: "apps/web/src/lib/outbox/outbox.ts",
    find: "afterPaste(outcome) ? \"uncertain\" : \"failed\"", replace: "\"failed\"",
    run: ["apps/web/test/outbox.test.ts"], expect: "a first attempt answered 409 not_submitted" },
  { id: "b1-v11-hub-unknown-as-no-answer", task: "B1-V11", file: "apps/web/src/lib/catchup/answer.ts",
    find: "(e.status === 404 && e.code === \"unknown\" ? \"gone\" : e.code)", replace: "e.code",
    run: ["apps/web/test/catchup-answer.test.ts", "apps/web/test/answer-in-doubt-web.test.ts"], expect: "the hub's 404 unknown" },
  // ---- B3 validation (V20): a send refused right after a /clear goes again once, with the refreshed expectation
  { id: "b3-v20-no-refresh-retry", task: "V20", file: "apps/hub/src/adapters/fleet-adapters.ts",
    find: "if (!r.ok && r.error.code === \"no_pane\" && pane.sessionId !== undefined) {", replace: "if (false) {",
    run: ["apps/hub/test/fleet-adapters.test.ts"], expect: "to match object { problem: null }" },
  { id: "b3-v20-retry-ignores-window", task: "V20", file: "apps/hub/src/adapters/fleet-adapters.ts",
    find: "return now && now.window === sent.window && now.sessionId !== sent.sessionId ? now : null;",
    replace: "return now && now.sessionId !== sent.sessionId ? now : null;",
    run: ["apps/hub/test/fleet-adapters.test.ts"], expect: "to deeply equal { problem: 'no_pane', typedAt: +0 }" },
  { id: "b3-v4-revoked-kept", task: "V4", file: "apps/hub/src/adapters/fleet-adapters.ts",
    find: "      view.retain(new Set(nodes.map(n => n.name)));\n      for (const n of nodes) view.setStatus(n.name, n.status);\n      view.setLanes(lanes);\n",
    replace: "      for (const n of nodes) view.setStatus(n.name, n.status);\n      view.setLanes(lanes);\n",
    run: ["apps/hub/test/fleet-adapters.test.ts"], expect: "to deeply equal [ 'pc.aaaaaaaa.1'" },
  { id: "b3-v5-look-always-complete", task: "V5", file: "apps/hub/src/application/observation-service.ts",
    find: "return { complete: this.#fleet === \"ok\" && inTime };", replace: "return { complete: true };",
    run: ["apps/hub/test/observation-first-look.test.ts"], expect: "expected { complete: true } to deeply equal { complete: false }" },
  { id: "b3-v6-location-never-updated", task: "V6", file: "packages/domain/src/observation.ts",
    find: "      if (known && known.location !== w.location) {\n        known.location = w.location;\n        out.push({ type: \"WorkerMoved\", workerId: w.id, location: w.location });\n      }\n",
    replace: "",
    run: ["packages/domain/test/observation.test.ts"], expect: "expected [] to deeply equal [ { type: 'WorkerMoved'" },
  { id: "b3-v13-ipc-url", task: "V13", file: "apps/hub/src/adapters/fleet-client.ts",
    find: "new WebSocket(\"ws://fleet/v1/events\", { maxPayload: MAX_ANSWER_BYTES, headers: CLIENT, createConnection: () => createConnection(this.#socketPath) });",
    replace: "new WebSocket(`ws+unix:${this.#socketPath}:/v1/events`, { maxPayload: MAX_ANSWER_BYTES, headers: CLIENT });",
    run: ["apps/hub/test/fleet-client.test.ts"], expect: "The URL contains a fragment identifier" },
  { id: "b3-v18-session-name-from-title", task: "V18", file: "apps/hub/src/adapters/fleet-adapters.ts",
    find: "name: p.sessionName ?? null", replace: "name: p.title ?? null",
    run: ["apps/hub/test/fleet-session-name.test.ts"], expect: "to match object" },
  { id: "b3-v37-older-answer-applied", task: "V37", file: "apps/hub/src/adapters/fleet-adapters.ts",
    find: "if (view.inventoryEvents(node) === asked) view.setPanes(node, r.result.panes);", replace: "view.setPanes(node, r.result.panes);",
    run: ["apps/hub/test/fleet-adapters.test.ts"], expect: "expected 's-alpha' to be 's-new'" },
  // ---- B2 validation (V10): attachments named alike, keyed by position as the desktop list is
  { id: "t17-chat-attachment-key", task: "17", file: "apps/web/src/lib/phone/Chat.svelte",
    find: "{#each m.attachments ?? [] as a, i (`${a.id ?? a.name}-${i}`)}",
    replace: "{#each m.attachments ?? [] as a (a.name + (a.id ?? \"\"))}",
    run: ["apps/web/test/attachment-keys-web.test.ts"], expect: "each_key_duplicate" },
  // ---- B2 validation (V9): a reconnect's history settles a held message's pending attachments
  { id: "t17-history-settles-pending", task: "17", file: "apps/web/src/lib/feed.svelte.ts",
    find: "return f && x.attachments?.some(a => a.pending) ? { ...x, attachments: f } : x;",
    replace: "return x;",
    run: ["apps/web/test/feed-lost-attachments-web.test.ts"], expect: "a lost attachments frame" },
  // ---- B2 validation (V1): the fleet may read a finished upload in the node's own inbox, and nothing else there
  { id: "t7-inbox-readable-by-fleet", task: "7", file: "apps/node-agent/src/ops/node-files.ts",
    find: "if (o.inboxDir) { const inbox = await openInbox(path, o.inboxDir); if (inbox) return inbox; }",
    replace: "",
    run: ["apps/node-agent/test/inbox-read.test.ts"], expect: "serves a finished upload by path" },
  { id: "t7-inbox-partial-offered", task: "7", file: "apps/node-agent/src/ops/node-files.ts",
    find: "rel.split(sep)[0] === \".partial\"", replace: "false",
    run: ["apps/node-agent/test/inbox-read.test.ts"], expect: "refuses a partial upload" },
  // ---- B2 validation (V3): at most a few copies of one node at a time, under the fleet's bulk queue
  { id: "t13-copies-per-node-limit", task: "13", file: "apps/hub/src/adapters/fleet-adapters.ts",
    find: "const p = oneAtATime(node, () => copyFrom(node, path)).finally(() => copying.delete(k));",
    replace: "const p = copyFrom(node, path).finally(() => copying.delete(k));",
    run: ["apps/hub/test/fleet-copies-limit.test.ts"], expect: "toBeLessThanOrEqual" },
  // ---- B2 validation (V19): the (node, path) to copy link kept in the hub's persisted store
  { id: "t13-fleet-copies-persist", task: "13", file: "apps/hub/src/adapters/fleet-adapters.ts",
    find: "const stored = o.files?.known?.(`fleet:${k}`);",
    replace: "const stored = undefined as { size: number; mtimeMs: number; id: string } | undefined;",
    run: ["apps/hub/test/fleet-files-restart.test.ts"], expect: "copies across a hub restart" },
  // ---- B2 validation (V2): a retried upload whose partial expired starts again under a new name
  { id: "t12-upload-restart-on-bad-offset", task: "12", file: "apps/hub/src/adapters/fleet-adapters.ts",
    find: "if (!r.ok) { last = r; restart = r.restart === true; break; }",
    replace: "if (!r.ok) { last = r; restart = false; break; }",
    run: ["test/fleet/upload-retry-expired.test.ts"], expect: "expected false to be true" },
  { id: "pr12-older-anchor-by-call-id", task: "pr12", file: "apps/hub/src/adapters/claude-sessions.ts",
    find: " || (cut === -1 && l.type === \"assistant\" && !l.isSidechain && blocksOf(l).some(b => b.type === \"tool_use\" && b.id === beforeId))",
    replace: "",
    run: ["apps/hub/test/claude-sessions-older-anchors.test.ts"], expect: "before activity toolu_01ACT" },
  { id: "pr12-read-mark-newest-message", task: "pr12", file: "packages/domain/src/reading.ts",
    find: "Math.min(proposed, Math.max(now, newest ?? 0))", replace: "Math.min(proposed, now)",
    run: ["packages/domain/test/reading-newest.test.ts"], expect: "1010000" },
  { id: "pr12-hub-files-same-file", task: "pr12", file: "apps/hub/src/adapters/files.ts",
    find: "opened.dev !== st.dev || opened.ino !== st.ino", replace: "false",
    run: ["apps/hub/test/files-swap.test.ts"], expect: "to be null" },
  { id: "pr12-settle-outcome-drops-row", task: "pr12", file: "apps/hub/src/application/steering-service.ts",
    find: "if (outcome.problem) { if (nothingTyped(outcome.problem)) store.dropSend(key); return; }",
    replace: "if (outcome.problem) { return; }",
    run: ["apps/hub/test/typing-outcome.test.ts"], expect: "drop k" },
  { id: "pr12-redact-key-fields", task: "pr12", file: "packages/protocol/src/redact.ts",
    find: "|key|publicKey|fleetKey|", replace: "|",
    run: ["apps/hub/test/log-agreement.test.ts"], expect: "[redacted]" },
  { id: "pr12-unknown-op-error-code", task: "pr12", file: "apps/hub/src/adapters/fleet-client.ts",
    find: "? readOpError(v.code, v.executed, v.message) : null;",
    replace: "? { code: v.code as never, executed: v.executed, message: v.message } : null;",
    run: ["apps/hub/test/fleet-unknown-error-code.test.ts"], expect: "internal" },
  { id: "pr12-agent-ops-from-protocol", task: "pr12", file: "apps/node-agent/src/config.ts",
    find: "export const ALL_OPS: readonly OpName[] = OP_NAMES;", replace: "export const ALL_OPS: readonly OpName[] = [\"inventory.get\"];",
    run: ["apps/node-agent/test/ops-list.test.ts"], expect: "are the protocol" },
  { id: "pr12-max-file-bytes-from-limits", task: "pr12", file: "packages/node-ops/src/file-rules.ts",
    find: "MAX_FILE_BYTES = LIMITS.maxFileBytes;", replace: "MAX_FILE_BYTES = 25 << 20;",
    run: ["packages/node-ops/test/limits-one-definition.test.ts"], expect: "MAX_FILE_BYTES = LIMITS" },
  { id: "pr12-kit-migrate-refuses-future", task: "pr12", file: "packages/service-kit/src/migrate.ts",
    find: "if (first > known) throw refuse(first, known);", replace: "if (first > known) return { from: first, to: first };",
    run: ["packages/service-kit/test/service-kit.test.ts"], expect: "future 5 1" },
  { id: "pr12-follow-parallel", task: "pr12", file: "apps/hub/src/application/observation-service.ts",
    find: "const FOLLOW_PARALLEL = 4;", replace: "const FOLLOW_PARALLEL = 1;",
    run: ["apps/hub/test/observation-parallel.test.ts"], expect: "greater than 1" },
  { id: "pr12-frame-guard", task: "pr12", file: "packages/node-ops/src/terminal.ts",
    find: "if (guard && (fields.slice(6)", replace: "if (false && (fields.slice(6)",
    run: ["packages/node-ops/test/terminal-guard.test.ts"], expect: "to be null" },
  { id: "pr12-inbox-sweep-throttled", task: "pr12", file: "apps/node-agent/src/ops/upload-inbox.ts",
    find: "if (this.#now() - this.#sweptAt >= SWEEP_EVERY_MS) {", replace: "if (true) {",
    run: ["apps/node-agent/test/upload-inbox-scans.test.ts"], expect: "toBe(true)" },
  { id: "pr12-inventory-current", task: "pr12", file: "apps/node-agent/src/ops/inventory.ts",
    find: "performance.now() - this.#readAt <= maxAgeMs ? Promise.resolve(this.#snap) : this.refresh();", replace: "this.refresh();",
    run: ["apps/node-agent/test/inventory-current.test.ts"], expect: "toBe(1)" },
  // V45 (L6 retry): a live upload's idleness trusts the monotonic clock when the wall clock was stepped, and keeps the
  // mtime age otherwise (the 10-minute expiry that tests back-date).
  { id: "t8-inbox-monotonic-ttl", task: "8", file: "apps/node-agent/src/ops/upload-inbox.ts",
    find: "return Math.abs(wallSince - monoSince) > CLOCK_STEP_MS ? monoSince : now - mtimeMs;", replace: "return now - mtimeMs;",
    run: ["apps/node-agent/test/upload-inbox-clock-step.test.ts"], expect: "\"ok\": false" },
  { id: "v45-inbox-mtime-age-kept", task: "8", file: "apps/node-agent/src/ops/upload-inbox.ts",
    find: "return Math.abs(wallSince - monoSince) > CLOCK_STEP_MS ? monoSince : now - mtimeMs;", replace: "return monoSince;",
    run: ["apps/node-agent/test/transcript-file-ops.test.ts"], expect: "expired" },
  // ---- PR 1 (releases and updates, docs/design/updates/README.md §15, row 1): one guard per invariant in the
  // domain, each with the negative-control history in packages/domain/test/releases-invariants.test.ts that must
  // notice it gone.
  { id: "pr1-rl1-skip-a-check", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "if (facts[step] !== true) return err(step);", replace: "if (false) return err(step);",
    run: ["packages/domain/test/releases-invariants.test.ts"], expect: "manifest_digest" },
  { id: "pr1-rl2-auto-downgrade", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "if (compareVersions(target, machine.highestCommitted) <= 0) return err(\"not_newer\");",
    replace: "if (false) return err(\"not_newer\");",
    run: ["packages/domain/test/releases-invariants.test.ts"], expect: "not_newer" },
  { id: "pr1-rl3-feed-rollback", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "if (feed.seq < ask.highestSeq) return err(\"older\");", replace: "if (false) return err(\"older\");",
    run: ["packages/domain/test/releases-invariants.test.ts"], expect: "older" },
  { id: "pr1-rl4-no-apply-lock", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "if (!o.lockHeld) return err(\"apply_lock\");", replace: "if (false) return err(\"apply_lock\");",
    run: ["packages/domain/test/releases-invariants.test.ts"], expect: "apply_lock" },
  { id: "pr1-rl5-swap-without-backup", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "if (!backup || !backup.done) return err({ database: db, reason: \"backup_missing\" });",
    replace: "if (false) return err({ database: db, reason: \"backup_missing\" });",
    run: ["packages/domain/test/releases-invariants.test.ts"], expect: "backup_missing" },
  { id: "pr1-rl6-in-flight-skipped", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "for (const report of p.reports) for (const blocker of report.blockers)",
    replace: "for (const report of p.reports) for (const blocker of [] as string[])",
    run: ["packages/domain/test/releases-invariants.test.ts"], expect: "in_flight" },
  { id: "pr1-rl7-health-not-judged", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "for (const check of checks) if (report.checks[check] !== true) return err({ service, check });",
    replace: "for (const check of checks) if (false) return err({ service, check });",
    run: ["packages/domain/test/releases-invariants.test.ts"], expect: "/api/health" },
  // The review of 2026-10-11: RL7's "at the target Version" — a report naming another Version never passes.
  { id: "pr1-rl7-health-wrong-version", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "if (at === null || !equalVersions(at, p.target)) return err({ service, check: \"wrong_version\" });",
    replace: "if (false) return err({ service, check: \"wrong_version\" });",
    run: ["packages/domain/test/releases-invariants.test.ts"], expect: "wrong_version" },
  { id: "pr1-rl8-restore-without-backup", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "if (!p.backupPresent) return err(\"backup_gone\");", replace: "if (false) return err(\"backup_gone\");",
    run: ["packages/domain/test/releases-invariants.test.ts"], expect: "backup_gone" },
  // The review of 2026-10-11: the plan's refusal of a target below the database's floor (RL8's forward rule).
  { id: "pr1-rl8-target-below-floor", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "if (target.version < now.floor) return err({ database: db, reason: \"target_below_floor\" });",
    replace: "if (false) return err({ database: db, reason: \"target_below_floor\" });",
    run: ["packages/domain/test/releases-invariants.test.ts"], expect: "target_below_floor" },
  // The review of 2026-10-11: restoreOnRollback without a migration marks a Backup-less database for a restore.
  { id: "pr1-rl8-restore-without-migration", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "restoreOnRollback: willMigrate && target.floor > previousKnows };",
    replace: "restoreOnRollback: target.floor > previousKnows };",
    run: ["packages/domain/test/releases-invariants.test.ts"], expect: "restoreOnRollback" },
  { id: "pr1-rl9-hold-passes-writes", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "return now - holdSince > HOLD_STALE_MS ? \"allowed\" : \"updating\";", replace: "return \"allowed\";",
    run: ["packages/domain/test/releases-invariants.test.ts"], expect: "updating" },
  { id: "pr1-rl10-other-store-typed", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "if (p.stampedStore === p.hubStore) return p.held ? \"duplicate\" : \"typed\";", replace: "if (true) return \"typed\";",
    run: ["packages/domain/test/releases-invariants.test.ts"], expect: "uncertain" },
  { id: "pr1-rl11-node-ahead", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "if (p.machine === \"node\" && compareVersions(p.target, p.controlPlane) > 0) return err({ reason: \"node_ahead\" });",
    replace: "if (false) return err({ reason: \"node_ahead\" });",
    run: ["packages/domain/test/releases-invariants.test.ts"], expect: "node_ahead" },
  { id: "pr1-rl11-protocol-dropped", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "&& (n.agentProtocol < min || n.agentProtocol > max)).map(n => n.name);", replace: "&& false).map(n => n.name);",
    run: ["packages/domain/test/releases-invariants.test.ts"], expect: "protocol_dropped" },
  { id: "pr1-rl12-halt-ignored", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "if (rollout.halted) return err(\"halted\");", replace: "if (false) return err(\"halted\");",
    run: ["packages/domain/test/releases-invariants.test.ts"], expect: "halted" },
  // The review of 2026-10-11: the guard that keeps the pin, the withdrawal and the halt off the principal's --rollback.
  { id: "pr1-rl12-rollback-escape", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "if (ask.kind !== \"rollback\") {", replace: "if (ask.kind !== \"rollback\" || true) {",
    run: ["packages/domain/test/releases-invariants.test.ts"], expect: "pinned" },
  { id: "pr1-rl13-outside-scope", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "if (!(UPDATE_SCOPE_SERVICES as readonly string[]).includes(name)) return err({ outside: name });",
    replace: "if (false) return err({ outside: name });",
    run: ["packages/domain/test/releases-invariants.test.ts"], expect: "outside" },
  { id: "pr1-rl13-tmux-in-unit", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "return p.tmuxInAgentUnit ? err(\"tmux_in_agent_unit\") : ok(true);", replace: "return ok(true);",
    run: ["packages/domain/test/releases-invariants.test.ts"], expect: "tmux_in_agent_unit" },
  { id: "pr1-rl14-disable-ignored", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "if (switches.disableUpdates) return err(\"updates_disabled\");", replace: "if (false) return err(\"updates_disabled\");",
    run: ["packages/domain/test/releases-invariants.test.ts"], expect: "updates_disabled" },
  // The tables (§4.4, §6.6, §7) with the controls of their own guards, in releases-state.test.ts.
  { id: "pr1-state-any-move", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "export const updateCanMove = (from: UpdateState, to: UpdateState): boolean => UPDATE_MOVES[from].includes(to);",
    replace: "export const updateCanMove = (from: UpdateState, to: UpdateState): boolean => from !== to;",
    run: ["packages/domain/test/releases-state.test.ts"], expect: "checked -> draining" },
  // The review of 2026-10-11: the swapping -> abandoned edge — a crash between the two renames abandons (§4.4, §6.6).
  { id: "pr1-state-swap-abandoned", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "swapping: [\"starting\", \"rolling_back\", \"abandoned\"],   // a crash between the two renames still runs the old Version",
    replace: "swapping: [\"starting\", \"rolling_back\"],",
    run: ["packages/domain/test/releases-state.test.ts"], expect: "swapping -> abandoned" },
  // The review of 2026-10-11: with no previous Version there is nothing to roll back to — refused, never a self-rollback.
  { id: "pr1-rollback-no-previous", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "if (previous === null) return err(\"no_previous\");",
    replace: "if (false) return err(\"no_previous\");",
    run: ["packages/domain/test/releases-state.test.ts"], expect: "no_previous" },
  // The review of 2026-10-11: a withdrawal compared as a string lets a Version with build metadata slip through.
  { id: "pr1-rl2-withdrawn-build-metadata", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "if (p.offered !== null && p.offered.feed.withdrawn.some(w => { const q = parseVersion(w); return q !== null && equalVersions(q, target); }))",
    replace: "if (p.offered !== null && p.offered.feed.withdrawn.includes(formatVersion(target)))",
    run: ["packages/domain/test/releases-invariants.test.ts"], expect: "withdrawn" },
  // The review of 2026-10-11: the old treePath regex let a NUL byte, a `.` segment and an empty segment through.
  { id: "pr1-wire-treepath-segments", task: "pr1", file: "packages/protocol/src/releases.ts",
    find: "z.regex(/^(?!\\.(?:\\/|$))(?!\\.\\.(?:\\/|$))[^/\\u0000\\n\\r\\u2028\\u2029]+(?:\\/(?!\\.(?:\\/|$))(?!\\.\\.(?:\\/|$))[^/\\u0000\\n\\r\\u2028\\u2029]+)*$/),",
    replace: "z.regex(/^(?!\\/)(?!.*(?:^|\\/)\\.\\.(?:\\/|$)).+$/),",
    run: ["packages/protocol/test/releases-wire.test.ts"], expect: "a NUL byte" },
  // The review of 2026-10-11: the updater's architecture scanner missed side-effect imports, and the "no other app"
  // check missed the package-name import @morndo/updater.
  { id: "pr1-arch-side-effect-imports", task: "pr1", file: "apps/updater/test/architecture.test.ts",
    find: "const importsOf = (code: string) => [...code.matchAll(/(?:import|export)\\s[^'\"]*?from\\s*[\"']([^\"']+)[\"']|import\\s*[\"']([^\"']+)[\"']|import\\(\\s*[\"']([^\"']+)[\"']\\s*\\)/g)].map(m => m[1] ?? m[2] ?? m[3] ?? \"\");",
    replace: "const importsOf = (code: string) => [...code.matchAll(/(?:import|export)\\s[^'\"]*?from\\s*[\"']([^\"']+)[\"']|import\\(\\s*[\"']([^\"']+)[\"']\\s*\\)/g)].map(m => m[1] ?? m[2] ?? \"\");",
    run: ["apps/updater/test/architecture.test.ts"], expect: "adapters/installer.ts" },
  { id: "pr1-arch-package-name-import", task: "pr1", file: "apps/updater/test/architecture.test.ts",
    find: "spec === \"@morndo/updater\" || spec.startsWith(\"@morndo/updater/\")",
    replace: "false",
    run: ["apps/updater/test/architecture.test.ts"], expect: "@morndo/updater" },
  // The review of 2026-10-11: a null keySet could never gain trust — the pinned root (§10.1) is the anchor it lacks.
  { id: "pr1-rl3-pinned-root-anchor", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "const prevRoots = i === 0 ? (have?.root ?? pinnedRoot) : offered[i - 1]!.set.root;",
    replace: "const prevRoots = i === 0 ? (have?.root ?? []) : offered[i - 1]!.set.root;",
    run: ["packages/domain/test/releases-invariants.test.ts"], expect: "unsigned_by_root" },
  { id: "pr1-rl3-pinned-root-both-sides", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "const rootsChanged = have !== null || i > 0 || pinnedRoot.length > 0 ? !sameKeys(prevRoots, step.set.root) : false;",
    replace: "const rootsChanged = have !== null || i > 0 ? !sameKeys(prevRoots, step.set.root) : false;",
    run: ["packages/domain/test/releases-invariants.test.ts"], expect: "root_change_one_side" },
  { id: "pr1-state-mark-any-order", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "if (!MARK_NEEDS[mark].includes(u.state)) return err(\"step_out_of_order\");",
    replace: "if (false) return err(\"step_out_of_order\");",
    run: ["packages/domain/test/releases-state.test.ts"], expect: "step_out_of_order" },
  { id: "pr1-recover-swap-as-abandon", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "if (equalVersions(p.current, p.preUpdate.current)) return ok({ act: \"abandon\" });",
    replace: "if (false) return ok({ act: \"abandon\" });",
    run: ["packages/domain/test/releases-state.test.ts"], expect: "abandon" },
  { id: "pr1-rollout-node-ahead-of-cp", task: "pr1", file: "packages/domain/src/releases.ts",
    find: "if (compareVersions(p.controlPlane, rollout.version) < 0) return err(\"waiting_control_plane\");",
    replace: "if (false) return err(\"waiting_control_plane\");",
    run: ["packages/domain/test/releases-state.test.ts"], expect: "waiting_control_plane" },
  // The wire schemas of the same PR (packages/protocol/src/releases.ts): the documents come from the network, so a
  // loosened schema is a guard gone. One entry per class of refusal, in releases-wire.test.ts.
  { id: "pr1-wire-unknown-field", task: "pr1", file: "packages/protocol/src/releases.ts",
    find: "export const KeySetSchema = z.strictObject({", replace: "export const KeySetSchema = z.object({",
    run: ["packages/protocol/test/releases-wire.test.ts"], expect: "expected true to be false" },
  { id: "pr1-wire-offset-time", task: "pr1", file: "packages/protocol/src/releases.ts",
    find: "z.pipe(z.string().check(z.iso.datetime()), z.transform(s => Date.parse(s)))",
    replace: "z.pipe(z.string(), z.transform(s => Date.parse(s)))",
    run: ["packages/protocol/test/releases-wire.test.ts"], expect: "expected true to be false" },
  { id: "pr1-wire-semver", task: "pr1", file: "packages/protocol/src/releases.ts",
    find: "const version = () => z.string().check(z.regex(SEMVER));", replace: "const version = () => z.string();",
    run: ["packages/protocol/test/releases-wire.test.ts"], expect: "expected true to be false" },
  { id: "pr1-wire-file-mode", task: "pr1", file: "packages/protocol/src/releases.ts",
    find: "const fileMode = z.string().check(z.regex(/^0[0-7]{3}$/));", replace: "const fileMode = z.string();",
    run: ["packages/protocol/test/releases-wire.test.ts"], expect: "expected true to be false" },
];

// ---- the runner

const ROOT = join(import.meta.dirname, "..");
const say = (line: string) => process.stdout.write(`${line}\n`);
const occurrences = (text: string, find: string) => (find ? text.split(find).length - 1 : 0);

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

// The entries themselves: unique ids, and every field filled.
function malformed(controls: readonly Control[]): string[] {
  const seen = new Set<string>();
  const bad: string[] = [];
  for (const c of controls) {
    if (seen.has(c.id)) bad.push(`${c.id}: a second entry with this id`);
    seen.add(c.id);
    if (!c.find || !c.file || !c.run.length || c.find === c.replace) bad.push(`${c.id}: needs a file, a find that differs from its replace, and tests to run`);
  }
  return bad;
}

// Every entry, whatever its platform: its text is in its file exactly once. The number that are not.
export function check(controls: readonly Control[]): number {
  let stale = 0;
  for (const c of controls) {
    let n = 0;
    try { n = occurrences(readFileSync(join(ROOT, c.file), "utf8"), c.find); } catch { n = -1; }
    if (n !== 1) stale++;
    say(`${n === 1 ? "ok   " : "STALE"} ${c.id}: ${n === -1 ? `${c.file} is missing` : `found ${n} time${n === 1 ? "" : "s"} in ${c.file}`}`);
  }
  return stale;
}

// How a vitest run ended. Only "failed" is a bite, and only when vitest itself reports a failed test and no breakage:
// an import or transform error, a syntax error, a failed suite or a missing file also exits non-zero, and a timeout
// leaves no status at all; none of them shows that a test noticed the missing guard.
type Run = { kind: "passed" | "failed" | "broke" | "timeout"; out: string; first: string };
// vitest's own banners, as it prints them (v5.0.3): "Failed Suites N" (a suite that did not load), "Error: Transform failed",
// "Error: Failed to load url", and "No test files found, exiting with code 1". A test that merely asserts on a message with
// such words in it is not matched: the markers are anchored to a line start.
const BREAKAGE = /^\s*(?:⎯+\s*)?Failed Suites\b|^\s*Error: Transform failed|^\s*(?:Error: )?Failed to load url|^\s*No test files found/m;
const FAILED_TESTS = /^\s*Tests\s+(\d+) failed/m;
const TIMEOUT_MS = Number(process.env.NEGATIVE_CONTROLS_TIMEOUT_MS) || 15 * 60_000;   // a run's limit; the runner's self-check lowers it
let child: ChildProcess | null = null;
let liveTree: string | null = null;
let stopping = false;                                         // a signal came: nothing more is run, the handler exits
const parked = () => new Promise<never>(() => {});

// `timedOut`: the runner's own limit stopped the run. A run with no status at all for any other reason (killed by a signal, an
// out-of-memory kill) has no result either, and is counted as timed out, with the signal in its first line.
export function classify(status: number | null, signal: string | null, out: string, timedOut = false): Run {
  const lines = out.split("\n").map(l => l.trim()).filter(Boolean);
  const first = lines.find(l => /^(?:Error: )?(?:Transform failed|Failed to load url)|No test files found|Error/.test(l)) ?? lines.find(l => /Failed Suites/.test(l)) ?? lines.find(l => /FAIL|×/.test(l)) ?? lines[0] ?? "(no output)";
  if (timedOut) return { kind: "timeout", out, first: `no result within ${TIMEOUT_MS / 1000} s` };
  if (status === null || signal) return { kind: "timeout", out, first: `killed by ${signal ?? "a signal"}` };
  if (status === 0) return { kind: "passed", out, first };
  const failedTests = Number(FAILED_TESTS.exec(out)?.[1] ?? 0);
  return { kind: failedTests >= 1 && !BREAKAGE.test(out) ? "failed" : "broke", out, first };
}

function vitest(tree: string, files: string[]): Promise<Run> {
  const treeName = basename(dirname(tree));
  return new Promise(resolve => {
    let out = "";
    const c = spawn(process.execPath, [join(tree, "node_modules/vitest/vitest.mjs"), "run", ...files], {
      cwd: tree, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" }, detached: true,
    });
    child = c;
    c.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    c.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    // The whole process group (vitest's workers too): asked to stop first, so the tests' own cleanup runs (their tmux servers),
    // then killed.
    const stop = (sig: NodeJS.Signals) => { try { if (c.pid) process.kill(-c.pid, sig); } catch { /* gone */ } };
    let hard: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => { timedOut = true; stop("SIGTERM"); hard = setTimeout(() => stop("SIGKILL"), 5000); }, TIMEOUT_MS);
    let timedOut = false;
    c.on("close", (status, signal) => {
      clearTimeout(timer); clearTimeout(hard); child = null; stop("SIGKILL");
      if (timedOut) reap(treeName);
      resolve(classify(status, signal, out, timedOut));
    });
    c.on("error", e => { clearTimeout(timer); clearTimeout(hard); child = null; resolve({ kind: "broke", out: String(e), first: String(e) }); });
  });
}
const tail = (out: string) => out.trim().split("\n").filter(l => /FAIL|×|Error|expected|Tests /.test(l)).slice(0, 6).map(l => `      ${l.trim()}`).join("\n");

// Kills what a run started and left running: every process whose command line contains this run's own temporary directory
// name (morndo-controls-XXXXXX, unique per run, so no other process matches). A tmux server daemonizes into a session of
// its own, so the process-group kill never reaches it; it and its panes are found by that name in their argv (the harness
// starts a lane with `-c <dir>` and the stand-in script from the tree). A tmux server whose argv does not contain the tree
// path is not caught. Asked to stop first (SIGTERM), killed (SIGKILL) after two seconds if it is still there.
function reap(name: string): void {
  if (!name.startsWith("morndo-controls-")) return;
  spawnSync("pkill", ["-f", "--", name]);
  if (spawnSync("pgrep", ["-f", "--", name]).status === 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    spawnSync("pkill", ["-9", "-f", "--", name]);
  }
}

// Removes the temporary worktree and its directory, once: a second call (a second signal) does nothing.
let liveTmp: string | null = null;
let keepTree = false;
function removeTree(): void {
  const tmp = liveTmp;
  if (!tmp) return;
  liveTmp = null;
  liveTree = null;
  reap(basename(tmp));
  const tree = join(tmp, "tree");
  if (existsSync(tree)) {
    try { git(ROOT, "worktree", "remove", "--force", tree); } catch (e) { say(`cleanup: ${(e as Error).message}; remove it with: git worktree remove --force ${tree}`); }
  }
  rmSync(tmp, { recursive: true, force: true });
  try { git(ROOT, "worktree", "prune"); } catch { /* nothing to prune */ }
}
function onSignal(signal: NodeJS.Signals, code: number) {
  process.on(signal, () => {
    if (stopping) return;                                     // a second signal while it cleans up
    stopping = true;
    const pid = child?.pid;
    try { if (pid) process.kill(-pid, "SIGTERM"); } catch { /* gone */ }
    setTimeout(() => {                                        // the tests' own cleanup gets a moment, then the group goes
      try { if (pid) process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
      if (keepTree && liveTmp) { reap(basename(liveTmp)); say(`kept: ${liveTree}`); } else removeTree();
      process.exit(code);
    }, 3000);
  });
}
// Registered when a run starts (a full run or --only), never at import and never for --check or --list.
function installSignalHandlers(): void {
  onSignal("SIGINT", 130);
  onSignal("SIGTERM", 143);
}

// The five outcomes' counts. Bit, still passes, broke and timed out are of the controls that apply here; skipped are not.
export type Tally = { bit: number; passes: number; broke: number; timeout: number; skipped: number };
// The summary line and the exit: 0 only when every control that applies on this platform bit, and at least one applied
// (a run of skipped controls alone showed nothing).
export function verdict(n: Tally, total: number): { line: string; code: 0 | 1 } {
  const applicable = total - n.skipped;
  return {
    line: `${n.bit}/${applicable} controls bit; still pass ${n.passes}, broke ${n.broke}, timed out ${n.timeout}, skipped ${n.skipped}`,
    code: applicable > 0 && n.bit === applicable ? 0 : 1,
  };
}

// Five outcomes are counted apart: bit, still passes, broke (the run was broken, or the setup was), timed out, and skipped
// (a control for another platform).
async function runAll(controls: readonly Control[], keep: boolean): Promise<number> {
  const head = git(ROOT, "rev-parse", "HEAD");
  if (git(ROOT, "status", "--porcelain")) say(`note: uncommitted changes are not in the run; it runs HEAD (${head.slice(0, 7)})`);
  const tmp = mkdtempSync(join(tmpdir(), "morndo-controls-"));
  const tree = join(tmp, "tree");
  liveTmp = tmp;
  liveTree = tree;
  keepTree = keep;
  installSignalHandlers();
  const n: Tally = { bit: 0, passes: 0, broke: 0, timeout: 0, skipped: 0 };
  const broke = (line: string) => { n.broke++; say(line); };
  let setupFailed = false;
  try {
    git(ROOT, "worktree", "add", "--detach", tree, head);
    const ci = spawnSync("npm", ["ci", "--offline", "--no-audit", "--no-fund"], { cwd: tree, encoding: "utf8" });
    if (ci.status !== 0) {
      say(`setup: npm ci --offline failed in ${tree} (run npm ci once in this checkout to fill npm's cache):\n${(ci.stdout + ci.stderr).trim().split("\n").slice(-8).join("\n")}`);
      return 2;
    }
    const baseline = new Map<string, Run>();
    for (const c of controls) {
      if (stopping) await parked();
      const path = join(tree, c.file);
      const original = readFileSync(path, "utf8");
      const found = occurrences(original, c.find);
      if (found !== 1) { broke(`STALE    ${c.id}: its text is found ${found} times in ${c.file}`); continue; }
      const need = needs(c);
      if (need) { n.skipped++; say(`SKIPPED  ${c.id}: skipped (needs ${need}); this is ${process.platform}`); continue; }
      const key = [...c.run].sort().join(" ");
      if (!baseline.has(key)) baseline.set(key, await vitest(tree, c.run));
      if (stopping) await parked();
      const before = baseline.get(key);
      if (before?.kind === "timeout") { n.timeout++; say(`TIMEDOUT ${c.id}: ${c.run.join(", ")} did not finish unchanged: ${before.first}`); continue; }
      if (before?.kind !== "passed") { broke(`BASELINE ${c.id}: ${c.run.join(", ")} fail without the change, so it proves nothing\n      ${before?.first ?? ""}\n${tail(before?.out ?? "")}`); continue; }
      writeFileSync(path, original.replace(c.find, () => c.replace));
      const after = await vitest(tree, c.run);
      if (stopping) await parked();
      git(tree, "checkout", "--", c.file);
      if (readFileSync(path, "utf8") !== original) { say(`setup: ${c.file} was not restored in ${tree}`); setupFailed = true; return 2; }
      if (after.kind === "timeout") { n.timeout++; say(`TIMEDOUT ${c.id}: ${c.run.join(", ")}: ${after.first}`); continue; }
      if (after.kind === "passed") { n.passes++; say(`PASSED   ${c.id}: ${c.run.join(", ")} still pass with the guard removed`); continue; }
      if (after.kind === "broke") { broke(`BROKE    ${c.id}: ${c.run.join(", ")} broke without a failed test: ${after.first}`); continue; }
      if (c.expect && !after.out.includes(c.expect)) { broke(`ELSEWHERE ${c.id}: the tests failed, but without "${c.expect}"\n${tail(after.out)}`); continue; }
      n.bit++;
      say(`bit      ${c.id}`);
    }
  } finally {
    if (keep) { reap(basename(tmp)); say(`kept: ${tree}`); }
    else removeTree();
  }
  const v = verdict(n, controls.length);
  say(v.line);
  return v.code === 0 && !setupFailed ? 0 : 1;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { only: { type: "string", multiple: true }, check: { type: "boolean" }, list: { type: "boolean" }, keep: { type: "boolean" } } });
  const bad = malformed(CONTROLS);
  if (bad.length) { for (const b of bad) say(`ENTRY    ${b}`); process.exit(1); }
  const chosen = values.only?.length ? CONTROLS.filter(c => values.only?.includes(c.id)) : CONTROLS;
  const unknown = (values.only ?? []).filter(id => !CONTROLS.some(c => c.id === id));
  if (unknown.length) { say(`no such control: ${unknown.join(", ")}`); process.exit(2); }
  if (values.list) { for (const c of chosen) say(`${c.id}\tTask ${c.task}\t${c.file}\t${c.run.join(" ")}`); process.exit(0); }
  if (values.check) process.exit(check(chosen) ? 1 : 0);
  process.exit(await runAll(chosen, values.keep ?? false));
}
