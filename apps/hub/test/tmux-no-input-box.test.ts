// F7: a send only goes into an agent's input box. A pane with no input box (the agent's CLI exited to a shell) is
// refused, and a real draft that starts with 'Try "' still counts as a draft. Private tmux server, synthetic panes.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpointId, sessionId } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { localTmux } from "../src/adapters/local-node.ts";
import { draftOnScreen, tmuxAdapter } from "@morndo/node-ops";
import { SteeringService } from "../src/application/steering-service.ts";
import type { Authenticated } from "../src/application/access-service.ts";

const SOCKET = `morndo-val-f7-${process.pid}`;
const FIXTURE = join(import.meta.dirname, "tmux-fake-claude.fixture.ts");
const tmux = (...a: string[]) => execFileSync("tmux", ["-L", SOCKET, ...a], { encoding: "utf8" });
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(f: () => boolean, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await wait(100); } return false; }
const now = Date.UTC(2026, 9, 1, 8);
const auth: Authenticated = {
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: now, lastSeenAt: now, verifiedAt: now - 1000, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: now, revokedAt: null },
};
let dir: string;
let store: Store;
let shell: string;
let box: string;
let boxDir: string;
const submitted = () => (existsSync(join(boxDir, "submitted.jsonl")) ? readFileSync(join(boxDir, "submitted.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as string) : []);
const screen = (pane: string) => tmux("capture-pane", "-p", "-t", pane);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "morndo-val-f7-"));
  boxDir = mkdtempSync(join(dir, "box-"));
  store = new Store(dir);
  tmux("new-session", "-d", "-s", "qa", "-x", "80", "-y", "20", "-c", dir, "bash --norc --noprofile");
  tmux("send-keys", "-t", "qa", "PS1='$ '; clear", "Enter");
  shell = tmux("list-panes", "-t", "qa", "-F", "#{pane_id}").trim();
  tmux("new-window", "-t", "qa", "-c", boxDir, `${process.execPath} ${FIXTURE} ${boxDir}`);
  box = tmux("list-panes", "-t", "qa:1", "-F", "#{pane_id}").trim();
  await until(() => screen(box).includes("❯") && /\$ $/m.test(screen(shell)));
}, 20_000);
afterAll(() => { try { tmux("kill-server"); } catch { /* gone */ } store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("a pane with no input box (F7)", () => {
  it("refuses a send into a plain shell pane: nothing runs there and no CommandSent is audited", async () => {
    const before = store.audit(50).length;
    const r = await new SteeringService(store, localTmux(tmuxAdapter({ socket: SOCKET, session: null })), () => now).send(auth, shell, "echo f7-$((40+2))", "f7-1");
    await wait(300);
    expect(screen(shell)).not.toContain("f7-42");                        // the shell never evaluated the text
    expect(store.audit(50).length).toBe(before);
    expect(r.ok).toBe(false);
  });
  it("still sends into an empty input box (control)", async () => {
    const r = await new SteeringService(store, localTmux(tmuxAdapter({ socket: SOCKET, session: null })), () => now).send(auth, box, "hello box", "f7-2");
    expect(r).toMatchObject({ ok: true });
    expect(await until(() => submitted().includes("hello box"))).toBe(true);
  });
});

describe("a typed draft that starts with 'Try \"' (F7)", () => {
  it("is a draft when it isn't dim (Claude Code draws its placeholder dim)", () => {
    const prompt = "\x1b[38;5;246m❯ \x1b[39m";
    expect(draftOnScreen(`──\n${prompt}Try "fix the build" first\n──`)).toBe('Try "fix the build" first');
  });
  it("blocks a send on the real screen, and nothing is merged into it", async () => {
    tmux("send-keys", "-t", box, "-l", 'Try "fix the build" first');
    expect(await until(() => screen(box).includes('Try "fix the build" first'))).toBe(true);
    const count = submitted().length;
    expect(await tmuxAdapter({ socket: SOCKET, session: null }).send(box, "another message")).toBe("draft_present");
    await wait(300);
    expect(submitted().length).toBe(count);
  });
});
