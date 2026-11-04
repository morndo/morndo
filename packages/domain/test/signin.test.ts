// Sign-in from the app (ADR-0039): the pure rules. Locked by the keryx run app-sign-in.
import { describe, expect, it } from "vitest";
import {
  SIGNIN_ACCOUNT, SIGNIN_FRESH_MS, SIGNIN_TTL_MS, acceptsCode, cardTitle, checkTarget, linkAllowed, settle, targetKey, type SignIn,
} from "../src/signin.ts";

const now = 1_800_000_000_000;
const live = (over: Partial<SignIn> = {}): SignIn => ({
  id: "si-1", target: { node: "n1", runtime: "claude", account: "a1" }, create: false, phase: "waiting",
  link: "https://claude.com/cai/oauth/authorize?code=true", userCode: null, needsCode: true, recipient: "age1example",
  startedAt: now, expiresAt: now + SIGNIN_TTL_MS, identity: null, problem: null, ...over,
});

describe("sign-in rules (ADR-0039)", () => {
  it("names accounts as the pool does: main, or a short lowercase name", () => {
    for (const ok of ["main", "a1", "a8", "work-2", "x_y"]) expect(SIGNIN_ACCOUNT.test(ok)).toBe(true);
    for (const bad of ["", "A1", "../a1", "a/b", "-a", "a".repeat(32), "a1 ", ".claude"]) expect(SIGNIN_ACCOUNT.test(bad)).toBe(false);
  });

  it("checks a target: a known runtime, a node name, an account name; Cursor signs in its main account only", () => {
    expect(checkTarget({ node: "n1", runtime: "claude", account: "a8" })).toEqual({ ok: true, target: { node: "n1", runtime: "claude", account: "a8" } });
    expect(checkTarget({ node: "n1", runtime: "codex", account: "a1" })).toEqual({ ok: false, problem: "bad_runtime" });
    expect(checkTarget({ node: "N1!", runtime: "claude", account: "a1" })).toEqual({ ok: false, problem: "bad_node" });
    expect(checkTarget({ node: "n1", runtime: "claude", account: "../x" })).toEqual({ ok: false, problem: "bad_account" });
    expect(checkTarget({ node: "n1", runtime: "cursor", account: "main" })).toEqual({ ok: true, target: { node: "n1", runtime: "cursor", account: "main" } });
    expect(checkTarget({ node: "n1", runtime: "cursor", account: "c2" })).toEqual({ ok: false, problem: "cursor_main_only" });
  });

  it("keys one live sign-in per target (SI1)", () => {
    expect(targetKey({ node: "n1", runtime: "claude", account: "a1" })).toBe("n1/claude/a1");
  });

  it("shows only https links on the runtime's own hosts (SI5)", () => {
    expect(linkAllowed("claude", "https://claude.com/cai/oauth/authorize?x=1")).toBe(true);
    expect(linkAllowed("claude", "https://claude.ai/oauth/authorize?x=1")).toBe(true);
    expect(linkAllowed("claude", "https://console.anthropic.com/oauth/code")).toBe(true);
    expect(linkAllowed("claude", "http://claude.com/cai/oauth/authorize")).toBe(false);
    expect(linkAllowed("claude", "https://claude.com.example.net/x")).toBe(false);
    expect(linkAllowed("claude", "https://cursor.com/loginDeepControl?x=1")).toBe(false);
    expect(linkAllowed("cursor", "https://cursor.com/loginDeepControl?challenge=a&uuid=b")).toBe(true);
    expect(linkAllowed("cursor", "https://www.cursor.com/loginDeepControl?x=1")).toBe(true);
    expect(linkAllowed("cursor", "javascript:alert(1)")).toBe(false);
    expect(linkAllowed("cursor", "not a url")).toBe(false);
  });

  it("takes a code only while one is awaited, before the deadline (SI2)", () => {
    expect(acceptsCode(live(), now + 1000)).toBe(true);
    expect(acceptsCode(live({ needsCode: false, recipient: null }), now)).toBe(false);
    expect(acceptsCode(live({ phase: "checking" }), now)).toBe(false);
    expect(acceptsCode(live(), now + SIGNIN_TTL_MS)).toBe(false);
  });

  it("expires a live sign-in at its deadline and never reopens a finished one (SI3, SI4)", () => {
    expect(settle(live(), now + SIGNIN_TTL_MS).phase).toBe("expired");
    expect(settle(live({ phase: "checking" }), now + SIGNIN_TTL_MS + 1).phase).toBe("expired");
    expect(settle(live(), now + 5).phase).toBe("waiting");
    for (const phase of ["done", "failed", "cancelled", "expired"] as const) {
      expect(settle(live({ phase }), now + SIGNIN_TTL_MS * 2).phase).toBe(phase);
    }
  });

  it("wants a passkey check from the last 5 minutes and gives a sign-in 10 minutes (SI7)", () => {
    expect(SIGNIN_FRESH_MS).toBe(5 * 60_000);
    expect(SIGNIN_TTL_MS).toBe(10 * 60_000);
  });

  it("titles the card in plain words", () => {
    expect(cardTitle({ node: "n1", runtime: "claude", account: "a1" }, false)).toBe("Claude a1 on n1 is signed out");
    expect(cardTitle({ node: "n1", runtime: "claude", account: "a8" }, true)).toBe("Add Claude account a8 on n1");
    expect(cardTitle({ node: "n1", runtime: "claude", account: "main" }, false)).toBe("Claude (main login) on n1 is signed out");
    expect(cardTitle({ node: "n1", runtime: "cursor", account: "main" }, false)).toBe("Cursor on n1 is signed out");
  });
});
