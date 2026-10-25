// What the fleet remembers of a protected lane's panes (T-440): a worker ID, a session and a working directory seen
// under a protected window name stay protected after the window is renamed, and so do their transcript files.
import type { Pane } from "@morndo/protocol";
import { describe, expect, it } from "vitest";
import { ProtectedIdentity } from "../src/application/protected-identity.ts";

const SID = "11111111-1111-4111-8111-111111111111";
const pane = (workerId: string, window: string, extra: Partial<Pane> = {}): Pane => ({ workerId, window, cwd: "/work/a", status: "idle", pid: 1, ...extra });

describe("ProtectedIdentity", () => {
  it("remembers the worker ID and session of a pane seen under a protected name, after a rename", () => {
    const t = new ProtectedIdentity(new Set(["manager"]));
    t.observe([pane("ctl.3fa2c1d0.0", "manager", { sessionId: SID, cwd: "/work/m" }), pane("ctl.3fa2c1d0.1", "worker-a", { sessionId: "22222222-2222-4222-8222-222222222222" })]);
    t.observe([pane("ctl.3fa2c1d0.0", "boss", { sessionId: SID, cwd: "/work/m" })]);
    expect(t.hasWorker("ctl.3fa2c1d0.0")).toBe(true);
    expect(t.hasWorker("ctl.3fa2c1d0.1")).toBe(false);
    expect(t.hasSession(SID)).toBe(true);
    expect(t.hasSession("22222222-2222-4222-8222-222222222222")).toBe(false);
  });

  it("protects a session's file, the project directory its working directory names, and the directory itself, on that node", () => {
    const t = new ProtectedIdentity(new Set(["manager"]));
    t.observe([pane("ctl.3fa2c1d0.0", "manager", { sessionId: SID, cwd: "/work/m" })]);
    expect(t.isProtectedPath("ctl", "/work/m")).toBe(true);
    expect(t.isProtectedPath("ctl", "/work/m/notes.txt")).toBe(true);
    expect(t.isProtectedPath("ctl", "/work/a/../m/notes.txt")).toBe(true);
    expect(t.isProtectedPath("ctl", "/data/.cfg/projects/-work-m/old.jsonl")).toBe(true);
    expect(t.isProtectedPath("ctl", `/anywhere/${SID}.jsonl`)).toBe(true);
    expect(t.isProtectedPath("ctl", "/work/mm/x")).toBe(false);
    expect(t.isProtectedPath("ctl", "/work/m/../a/x")).toBe(false);
    expect(t.isProtectedPath("ctl", "/data/.cfg/projects/-work-mm/x")).toBe(false);
    expect(t.isProtectedPath("pc", "/work/m/notes.txt")).toBe(false);           // a directory belongs to its node
  });

  it("starts from the lanes the registry already holds", () => {
    const t = new ProtectedIdentity(new Set(["manager"]));
    t.seed([{ name: "manager", node: "ctl", workerId: "ctl.3fa2c1d0.0", conflict: false }, { name: "worker-a", node: "ctl", workerId: "ctl.3fa2c1d0.1", conflict: false }]);
    expect(t.hasWorker("ctl.3fa2c1d0.0")).toBe(true);
    expect(t.hasWorker("ctl.3fa2c1d0.1")).toBe(false);
  });
});
