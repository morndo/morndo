// A Claude Code session for a test pane, in the shapes Claude Code 2.1.293 writes (fleet clients README §1, §5; plan
// Global Constraints: synthetic texts in the recorded shapes):
// - the session file <claude>/sessions/<pid>.json naming the pane (its `tmux` field ends in the pane ID), with the
//   `status` the test sets, or none (a session file from before 2.1.293, or Claude Code still starting);
// - a transcript <claude>/projects/-test/<session>.jsonl, in which follow() turns each line the agent's fake box
//   (fake-claude.fixture.ts) submitted into a typed `user` prompt, the receipt the deliverer reads.
// The pid is the pane's own process (#{pane_pid}), alive for as long as the pane runs, as the session registry requires.
// The agent's tests use this rather than the shared fake box (test/fixtures/fake-claude-pane.ts), which Task 16 rewrites
// for the drills.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionStatus } from "@morndo/protocol";
import type { TestTmux } from "./helpers.ts";

export type TestSession = {
  sessionId: string;
  pid: number;
  transcript: string;
  status(s: SessionStatus | null): void;           // rewrite the session file with this status (null: the field absent)
  follow(stateDir: string): () => void;            // write a prompt for each submitted line; the result stops it
  end(): void;                                     // the session file gone
};

export function claudeSession(o: { tmux: TestTmux; claudeDir: string; pane: string; tmuxSession?: string; sessionId?: string }): TestSession {
  const sessionId = o.sessionId ?? randomUUID();
  const pid = Number(o.tmux.tmux("display-message", "-p", "-t", o.pane, "#{pane_pid}").trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`no process in pane ${o.pane}`);
  const sessions = join(o.claudeDir, "sessions");
  const project = join(o.claudeDir, "projects", "-test");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(project, { recursive: true });
  const file = join(sessions, `${pid}.json`);
  const transcript = join(project, `${sessionId}.jsonl`);
  const write = (status: SessionStatus | null) => writeFileSync(file, JSON.stringify({
    pid, sessionId, tmux: `${o.tmuxSession ?? "main"}:@0.${o.pane}`, name: null, cwd: o.claudeDir, version: "2.1.293",
    updatedAt: Date.now(), ...(status === null ? {} : { status }),
  }));
  write(null);
  return {
    sessionId, pid, transcript,
    status: write,
    follow(stateDir) {
      let seen = 0;
      const timer = setInterval(() => {
        const f = join(stateDir, "submitted.jsonl");
        if (!existsSync(f)) return;
        const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
        for (const l of lines.slice(seen)) {
          appendFileSync(transcript, `${JSON.stringify({
            type: "user", uuid: randomUUID(), timestamp: new Date().toISOString(), promptSource: "typed",
            message: { role: "user", content: JSON.parse(l) as string },
          })}\n`);
        }
        seen = lines.length;
      }, 25);
      return () => clearInterval(timer);
    },
    end: () => rmSync(file, { force: true }),
  };
}
