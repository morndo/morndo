// Sending into a pane: freshness (AC7), idempotency, guards, audit without the text. Real tmux, private server.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMMAND_FRESHNESS_MS, endpointId, sessionId } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { draftOnScreen, inputBoxOnScreen, menuOnScreen, tmuxAdapter } from "@morndo/node-ops";
import { localTmux } from "../src/adapters/local-node.ts";
import { SteeringService } from "../src/application/steering-service.ts";
import { uploadInbox } from "../src/adapters/uploads.ts";
import type { Authenticated } from "../src/application/access-service.ts";

const SOCKET = `morndo-steer-${process.pid}`;
// The hub's port onto this machine's tmux, as main.ts builds it in legacy mode.
const typist = () => localTmux(tmuxAdapter({ socket: SOCKET, session: null }));
const tmux = (...a: string[]) => execFileSync("tmux", ["-L", SOCKET, ...a], { encoding: "utf8" });
let dir: string;
let store: Store;
let pane: string;
const now = Date.UTC(2026, 9, 1, 8);
const auth = (verifiedAt: number): Authenticated => ({
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: verifiedAt, lastSeenAt: now, verifiedAt, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: now, revokedAt: null },
});

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "morndo-steer-"));
  store = new Store(dir);
  tmux("new-session", "-d", "-s", "qa", "-x", "80", "-y", "20", "bash --norc --noprofile");
  tmux("send-keys", "-t", "qa", "PS1='$ '; clear", "Enter");
  pane = tmux("list-panes", "-t", "qa", "-F", "#{pane_id}").trim();
});
afterAll(() => { try { tmux("kill-server"); } catch { /* gone */ } store.close(); rmSync(dir, { recursive: true, force: true }); });

// The hub types only into an agent's input box (tmux.ts inputBoxOnScreen): a ─ rule over a "❯" line. Drawn here in the
// bash pane above its prompt, so what is pasted still reaches bash and the tests can see it run.
let draws = 0;
async function drawBox(promptLine = "❯ ") {
  // A marker of its own, so the wait below can't pass on the previous test's box; printf builds it, so the typed command
  // line doesn't already show it.
  const n = ++draws;
  tmux("send-keys", "-t", pane, `clear; printf '%s-%s\\n' box ${n}; printf '──────\\n${promptLine}\\n'`, "Enter");
  // Wait until this box is on screen: a fixed pause lost the race on a loaded box (send saw no_input_box).
  for (let t = 0; t < 50; t++) {
    const shown = tmux("capture-pane", "-p", "-e", "-t", pane);
    if (shown.includes(`box-${n}`) && inputBoxOnScreen(shown)) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`drawBox: box-${n} not on screen after 5 s`);
}

describe("screen guards", () => {
  it("sees a menu and a draft in Claude Code's input line, but not the empty placeholder", () => {
    expect(menuOnScreen("Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel")).toBe(true);
    expect(menuOnScreen("all good\n❯ ")).toBe(false);
    expect(draftOnScreen("──────\n❯ half-typed message\n──────")).toBe("half-typed message");
    expect(draftOnScreen("──────\n❯ \n──────")).toBeNull();
    expect(draftOnScreen('──────\n❯ Try "fix the tests"\n──────')).toBeNull();
  });
  it("with colors: dim ghost text (a prompt suggestion) is not a draft; normal text is", () => {
    const prompt = "\x1b[38;5;246m❯\u00a0\x1b[39m";
    expect(draftOnScreen(`──\n${prompt}\x1b[2mmerge 917 918 919\x1b[22m\n──`)).toBeNull();
    expect(draftOnScreen(`──\n${prompt}\x1b[2;38;5;244mcheck the PR\x1b[0m\n──`)).toBeNull();
    expect(draftOnScreen(`──\n${prompt}\n──`)).toBeNull();
    expect(draftOnScreen(`──\n${prompt}half typed\n──`)).toBe("half typed");
    expect(draftOnScreen(`──\n${prompt}\x1b[2mghost\x1b[22m and typed\n──`)).toBe("and typed");
  });
});

describe("sending", () => {
  it("needs a verification from the last 10 minutes when the policy says so (AC7)", async () => {
    const s = new SteeringService(store, typist(), () => now, () => ({ stay: "12h", stepUp: "10m" }));
    expect(await s.send(auth(now - COMMAND_FRESHNESS_MS), pane, "echo x", "r0")).toEqual({ ok: false, problem: "step_up" });
  });
  it("types the text into the pane, once per request, and audits length and hash only", async () => {
    const s = new SteeringService(store, typist(), () => now);
    await drawBox();
    expect(await s.send(auth(now - 1000), pane, "echo steer-$((40+2))", "r1")).toMatchObject({ ok: true });
    expect(await s.send(auth(now - 1000), pane, "echo steer-$((40+2))", "r1")).toMatchObject({ ok: false, problem: "duplicate" });
    await new Promise(r => setTimeout(r, 300));
    expect(tmux("capture-pane", "-p", "-t", pane)).toContain("steer-42");
    const audit = store.audit(1)[0];
    expect(audit?.type).toBe("CommandSent");
    expect(JSON.stringify(audit)).not.toContain("steer");
    expect(audit?.body).toMatchObject({ workerId: pane, length: "echo steer-$((40+2))".length });
  });
  it("a send written to another worker than the one now in that pane is refused, and nothing is typed (review M2)", async () => {
    const s = new SteeringService(store, typist(), () => now, undefined, null, () => "none", () => "alpha");
    await drawBox();
    expect(await s.send(auth(now - 1000), pane, "echo moved-$((40+3))", "r-m2", [], "none", "beta")).toEqual({ ok: false, problem: "no_pane" });
    await new Promise(r => setTimeout(r, 300));
    expect(tmux("capture-pane", "-p", "-t", pane)).not.toContain("moved-43");
    expect(await s.send(auth(now - 1000), pane, "echo moved-$((40+3))", "r-m2b", [], "none", "alpha")).toMatchObject({ ok: true });
    expect(await s.send(auth(now - 1000), pane, "echo noname", "r-m2c", [], "none")).toMatchObject({ ok: true });   // an older app: no check
  });
  it("an attached image goes after the text as the note workers read; another device's upload is refused (S2, S3)", async () => {
    const inbox = uploadInbox({ dir: join(dir, "inbox"), now: () => now });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    const mine = await inbox.save(png, endpointId("ep1"));
    const theirs = await inbox.save(png, endpointId("ep2"));
    if (!mine.ok || !theirs.ok) throw new Error("setup");
    const s = new SteeringService(store, typist(), () => now, undefined, inbox);
    await drawBox();
    expect(await s.send(auth(now - 1000), pane, "", "img0", [theirs.value.id])).toEqual({ ok: false, problem: "not_yours" });
    expect(await s.send(auth(now - 1000), pane, "echo look-at-this", "img1", [mine.value.id])).toMatchObject({ ok: true });
    await new Promise(r => setTimeout(r, 400));
    const screen = tmux("capture-pane", "-p", "-J", "-t", pane, "-S", "-20");
    expect(screen).toContain("look-at-this");
    expect(screen).toContain(`[The owner attached a file: ${mine.value.path}]`);
    expect(store.audit(1)[0]?.body).toMatchObject({ type: "CommandSent", attachments: 1 });
    expect(JSON.stringify(store.audit(1))).not.toContain(mine.value.path);
  });
  it("sends past dim ghost text, but not past normal text in the input line (real tmux)", async () => {
    const s = new SteeringService(store, typist(), () => now);
    await drawBox("\\033[38;5;246m❯\\302\\240\\033[39m\\033[2mmerge 917\\033[22m");
    const shown = tmux("capture-pane", "-p", "-e", "-t", pane);
    expect(shown).toMatch(/\x1b\[2m(\x1b\[[0-9;]*m)*merge 917/);    // the ghost line is really on screen, and dim
    expect(draftOnScreen(shown)).toBeNull();
    expect(await s.send(auth(now - 1000), pane, "echo ghost-ok", "g1")).toMatchObject({ ok: true });
    await drawBox("\\033[38;5;246m❯\\302\\240\\033[39mhalf typed");
    expect(await s.send(auth(now - 1000), pane, "echo blocked", "g2")).toEqual({ ok: false, problem: "draft_present" });
    tmux("send-keys", "-t", pane, "clear", "Enter");
    await new Promise(r => setTimeout(r, 300));
  });
  it("follows the principal's policy: 'only at sign-in' needs no fresh check", async () => {
    const s = new SteeringService(store, typist(), () => now, () => ({ stay: "7d", stepUp: "signin" }));
    await drawBox();
    expect(await s.send(auth(now - 5 * 3600_000), pane, "echo policy-ok", "p1")).toMatchObject({ ok: true });
    const strict = new SteeringService(store, typist(), () => now, () => ({ stay: "7d", stepUp: "10m" }));
    expect(await strict.send(auth(now - 11 * 60_000), pane, "echo x", "p2")).toEqual({ ok: false, problem: "step_up" });
  });
  it("refuses empty text and unknown panes", async () => {
    const s = new SteeringService(store, typist(), () => now);
    expect(await s.send(auth(now), pane, "   ", "r2")).toEqual({ ok: false, problem: "empty" });
    expect(await s.send(auth(now), "%999", "hi", "r3")).toEqual({ ok: false, problem: "no_pane" });
  });
});
