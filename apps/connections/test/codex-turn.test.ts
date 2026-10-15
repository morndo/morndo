// A pool turn's stream (ADR-0029, §6.8): what a failure was, when the account comes back, and the arguments of the turn that
// goes on elsewhere. Messages are codex-cli 0.161.0's (codex-rs/protocol/src/error.rs at rust-v0.161.0).
import { describe, expect, it } from "vitest";
import { classifyFailure, continuationArgs, handoffArgs, promptOf, resumesLast, retryAt, sessionOf } from "../src/adapters/codex-turn.ts";

const LIMIT = "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:05 PM.";
const NOON = Date.UTC(2026, 9, 15, 12);

describe("codex turn: what a failure was", () => {
  it("tells a usage limit, one model's limit, a dead sign-in and an unreadable session from the rest", () => {
    expect(classifyFailure([LIMIT])).toEqual({ kind: "usage-limit", model: false });
    expect(classifyFailure(["You've hit your usage limit for Model Big. Switch to another model now, or try again at 3:05 PM."])).toEqual({ kind: "usage-limit", model: true });
    expect(classifyFailure(["Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again."])).toEqual({ kind: "auth" });
    expect(classifyFailure(["invalid_encrypted_content: The encrypted content could not be verified."])).toEqual({ kind: "unreadable" });
    expect(classifyFailure(["rate limit exceeded: try again in 2s"])).toEqual({ kind: "other" });
    expect(classifyFailure(["exceeded retry limit, last status: 429 Too Many Requests"])).toEqual({ kind: "other" });
  });

  it("reads the reset from the message, today or on a date, in the process's time zone", () => {
    expect(retryAt(LIMIT, NOON, "UTC")).toBe(Date.UTC(2026, 9, 15, 15, 5));
    expect(retryAt("… or try again at Oct 17th, 2026 9:00 AM.", NOON, "UTC")).toBe(Date.UTC(2026, 9, 17, 9, 0));
    expect(retryAt("… or try again at 3:05 PM.", NOON, "Europe/Berlin")).toBe(Date.UTC(2026, 9, 15, 13, 5));
    expect(retryAt("… try again at 11:00 AM.", NOON, "UTC")).toBeNull();
    expect(retryAt("You’ve hit your usage limit.", NOON, "UTC")).toBeNull();
  });
});

describe("codex turn: the arguments of the turn that goes on", () => {
  it("resumes the session with the turn's flags, the sandbox as a config value, and the prompt replaced", () => {
    const first = ["exec", "--json", "-m", "model-x", "-c", 'model_reasoning_effort="high"', "-s", "danger-full-access", "Make hello.txt"];
    const again = ["exec", "resume", "t-1", "--json", "-m", "model-x", "-c", 'sandbox_mode="danger-full-access"', "Next brief"];
    expect([sessionOf(first), sessionOf(again), promptOf(first), promptOf([...first.slice(0, -1), "-"])]).toEqual([null, "t-1", "Make hello.txt", null]);
    expect(continuationArgs(first, "t-1", "GO ON")).toEqual(["exec", "resume", "t-1", "--json", "-m", "model-x", "-c", 'model_reasoning_effort="high"', "-c", 'sandbox_mode="danger-full-access"', "GO ON"]);
    expect(continuationArgs(again, "t-1", "GO ON")).toEqual([...again.slice(0, -1), "GO ON"]);
    expect(handoffArgs(again, "HAND OFF")).toEqual(["exec", "--json", "-m", "model-x", "-c", 'sandbox_mode="danger-full-access"', "HAND OFF"]);
  });
});

describe("codex turn: reading `exec resume` as the CLI does", () => {
  it("finds the session id after options, and never takes a flag or its value for it", () => {
    expect(sessionOf(["exec", "resume", "--json", "-m", "model-x", "t-1", "go on"])).toBe("t-1");
    expect(sessionOf(["exec", "resume", "-c", 'sandbox_mode="x"', "--skip-git-repo-check", "t-2", "go on"])).toBe("t-2");
    expect(sessionOf(["exec", "resume", "--model=model-x", "t-3", "go on"])).toBe("t-3");
    expect(sessionOf(["exec", "--json", "go on"])).toBeNull();
  });

  it("knows --last and --all, which name no session, and takes the prompt as the last word either way", () => {
    expect([resumesLast(["exec", "resume", "--last", "continue"]), resumesLast(["exec", "resume", "t-1", "continue"]), resumesLast(["exec", "--json", "x"])]).toEqual([true, false, false]);
    expect(sessionOf(["exec", "resume", "--last", "continue"])).toBeNull();
    expect(sessionOf(["exec", "resume", "--json", "--last", "continue"])).toBeNull();
    expect(promptOf(["exec", "resume", "--last", "continue"])).toBe("continue");
  });

  it("has no prompt when the only word after the options is the session id", () => {
    expect(promptOf(["exec", "resume", "--json", "t-1"])).toBeNull();
  });

  it("drops the session id for a handoff wherever it stands", () => {
    expect(handoffArgs(["exec", "resume", "--json", "-m", "model-x", "t-1", "go on"], "HAND")).toEqual(["exec", "--json", "-m", "model-x", "HAND"]);
  });
});
