// Older pages before every kind of message the app can hold first (V12): a text and a prompt are found by their line's
// uuid; an activity and a question by their tool call's id, a file by `<call id>:files`. Synthetic transcripts only.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localTranscriptBytes } from "@morndo/node-ops";
import { followTranscript, olderPage } from "../src/adapters/claude-sessions.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-older-anchors-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function build() {
  let n = 0, t = Date.UTC(2026, 9, 2, 8), parent: string | null = null;
  const lines: object[] = [];
  const push = (l: Record<string, unknown>) => {
    const uuid = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    lines.push({ parentUuid: parent, isSidechain: false, sessionId: "s1", uuid, timestamp: new Date((t += 1000)).toISOString(), ...l });
    parent = uuid;
    return uuid;
  };
  const text = (s: string) => push({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: s }] } });
  const tool = (id: string, name: string, input: unknown, result: string) => {
    push({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
    push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result }] } });
  };
  text("hello");
  tool("toolu_01ACT", "Bash", { command: "ls" }, "x");
  tool("toolu_01QUE", "AskUserQuestion", { questions: [{ question: "Which?", options: [{ label: "A" }] }] }, "A");
  tool("toolu_01FIL", "Bash", { command: "lanes sendfile /tmp/v12/out.png" }, "sent /tmp/v12/out.png");
  text("later");
  const path = join(dir, "s.jsonl");
  writeFileSync(path, `${lines.map(l => JSON.stringify(l)).join("\n")}\n`);
  return localTranscriptBytes(path);
}

describe("older pages before an activity, a question or a file", () => {
  it("every message the follow shows can be the anchor of an older page that holds what lies before it", async () => {
    const src = build();
    const live = (await followTranscript(src, { offset: 0, pending: new Set() }, "builder")).entries.filter(e => e.kind !== "answer");
    expect(live.map(e => e.id).slice(1, 5)).toEqual(["toolu_01ACT", "toolu_01QUE", "toolu_01FIL", "toolu_01FIL:files"]);
    for (const [i, e] of live.entries()) {
      const page = await olderPage(src, "builder", e.id);
      expect(page.missing, `before ${e.kind} ${e.id}`).toBeUndefined();
      expect(page.messages.map(m => m.id), `before ${e.kind} ${e.id}`).toEqual(live.slice(0, i).map(m => m.id));
      expect(page.done).toBe(true);
    }
  });
  it("an id that is no message's still gives nothing, and says so (negative control)", async () => {
    const src = build();
    for (const id of ["toolu_nope", "toolu_nope:files", "00000000-0000-4000-8000-999999999999:0"]) expect(await olderPage(src, "builder", id)).toMatchObject({ messages: [], missing: true });
  });
});
