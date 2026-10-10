// F13: an agent's prose that mentions a menu phrase, above its empty input box, is not a menu. Sends go through, and
// no "Waiting at a prompt" decision appears. Private tmux server, synthetic pane (tmux-fake-claude.fixture.ts).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "../src/adapters/store.ts";
import { menuOnScreen, tmuxAdapter } from "@morndo/node-ops";
import { EscalationService } from "../src/application/escalation-service.ts";

const SOCKET = `morndo-val-f13-${process.pid}`;
const FIXTURE = join(import.meta.dirname, "tmux-fake-claude.fixture.ts");
const tmux = (...a: string[]) => execFileSync("tmux", ["-L", SOCKET, ...a], { encoding: "utf8" });
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(f: () => boolean, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await wait(100); } return false; }
const PROSE = "I changed the schema and wrote the migration.\nDo you want to proceed with the migration now, or should I wait for the backup?";
let dir: string;
let box: string;
let store: Store;
const submitted = () => (existsSync(join(dir, "submitted.jsonl")) ? readFileSync(join(dir, "submitted.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as string) : []);
const styled = () => tmux("capture-pane", "-p", "-e", "-t", box, "-S", "-30");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "morndo-val-f13-"));
  writeFileSync(join(dir, "prose.txt"), PROSE);
  store = new Store(mkdtempSync(join(dir, "store-")));                    // opening the database can take seconds here
  tmux("new-session", "-d", "-s", "qa", "-x", "100", "-y", "20", "-c", dir, `${process.execPath} ${FIXTURE} ${dir}`);
  box = tmux("list-panes", "-t", "qa", "-F", "#{pane_id}").trim();
  await until(() => styled().includes("❯"));
}, 20_000);
afterAll(() => { try { tmux("kill-server"); } catch { /* gone */ } store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("prose above an empty input box (F13)", () => {
  it("is not a menu on the screen", () => {
    expect(styled()).toContain("Do you want to proceed with the migration");
    expect(menuOnScreen(styled())).toBe(false);
  });
  it("lets a send through, and the text arrives", async () => {
    expect(await tmuxAdapter({ socket: SOCKET, session: null }).send(box, "go ahead")).toBeNull();
    expect(await until(() => submitted().includes("go ahead"))).toBe(true);
  });
  it("raises no 'Waiting at a prompt' decision", () => {
    const screen = tmux("capture-pane", "-p", "-J", "-t", box, "-S", "-150");
    const s = new EscalationService({
      watch: { workers: () => [{ id: box, name: "builder" }], history: () => [], openQuestions: () => [], screen: () => screen },
      ledger: null, store, managerName: "manager", send: async () => ({ problem: null, typedAt: 0 }),
    });
    s.poll();
    expect(s.board().items.map(i => i.title)).toEqual([]);
  });
  it("a real menu is still a menu (control)", () => {
    expect(menuOnScreen("Bash command\n  npm run migrate\nDo you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently\n\nEsc to cancel")).toBe(true);
  });
});
