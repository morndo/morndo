// The console's one-time approval code on a memory Ask's card (ADR-0031 round 3, docs/design/memory/README.md "App"):
// the note's id out of the Ask's, the command that spends the code, the words for each of the route's refusals, and the
// reveal that holds the code only until it is closed or runs out — an expired code is dropped, not merely unsaid. Pure
// units, no browser. Synthetic data only.
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/lib/api.ts";
import {
  CLOSED, consoleCommand, current, explainCodeProblem, noteIdOfAsk, shownFor, validUntil,
} from "../src/lib/desktop/memory-code.ts";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const CODE = "K7M2-9QPX-4TWB";

describe("noteIdOfAsk", () => {
  it("reads the note's own id out of the Ask a pending note files (mem-n-12 → N-12)", () => {
    expect(noteIdOfAsk("mem-n-12")).toBe("N-12");
    expect(noteIdOfAsk("mem-n-1")).toBe("N-1");
    expect(noteIdOfAsk("mem-n-123456789")).toBe("N-123456789");   // nine digits: the hub's own widest id
  });

  it("refuses anything else: another ask, a malformed id, a leading zero, a number too wide", () => {
    for (const id of ["ny-7", "d-1", "mem-x", "mem-n-0", "mem-n-01", "mem-n-1234567890", "mem-n-12-x", "Mem-n-12", ""]) {
      expect(noteIdOfAsk(id)).toBeNull();
    }
  });
});

describe("consoleCommand", () => {
  it("is the exact line the console takes", () => {
    expect(consoleCommand("N-12", CODE)).toBe(`morndo memory approve N-12 --code ${CODE}`);
  });
});

describe("explainCodeProblem", () => {
  it("says each of the route's own refusals in words", () => {
    expect(explainCodeProblem(new ApiError(403, "step_up"))).toBe("Verify with your passkey first, then ask again.");
    expect(explainCodeProblem(new ApiError(409, "not_pending"))).toBe("This note is already decided: there is nothing to approve.");
    expect(explainCodeProblem(new ApiError(404, "not_found"))).toBe("This note is gone.");
    expect(explainCodeProblem(new ApiError(404, "memory_off"))).toBe("Memory is off on this hub.");
    expect(explainCodeProblem(new ApiError(429, "rate_limited", 30_000))).toBe("Too many tries; wait a moment.");
  });

  it("falls back to the hub's shared words for anything else", () => {
    expect(explainCodeProblem(new ApiError(500, "internal error"))).toBe('The hub answered "internal error".');
    expect(explainCodeProblem(new Error("boom"))).toBe("boom");
  });
});

describe("the reveal", () => {
  const minted = { ok: true as const, code: CODE, expiresAt: NOW + 600_000 };

  it("shownFor keeps what was asked for, with the command; a refusal keeps only its words", () => {
    expect(shownFor("N-12", minted)).toEqual({
      kind: "shown", noteId: "N-12", code: CODE, expiresAt: NOW + 600_000,
      command: `morndo memory approve N-12 --code ${CODE}`,
    });
    expect(shownFor("N-12", { ok: false, text: "This note is gone." })).toEqual({ kind: "failed", text: "This note is gone." });
  });

  it("an expired code is dropped: current() leaves only the words to ask again", () => {
    const r = current(shownFor("N-12", minted), NOW + 600_000);
    expect(r).toEqual({ kind: "failed", text: "The code expired. Ask for a new one." });
    expect(JSON.stringify(r)).not.toContain(CODE);   // the code itself is gone from what it returns, not just unsaid
  });

  it("a code inside its window stays as it is, and CLOSED carries nothing", () => {
    expect(current(shownFor("N-12", minted), NOW + 599_999)).toEqual(shownFor("N-12", minted));
    expect(CLOSED).toEqual({ kind: "idle" });
    expect(JSON.stringify(CLOSED)).not.toContain(CODE);
  });
});

describe("validUntil", () => {
  it("whole minutes left, rounded up, never less than one", () => {
    expect(validUntil(NOW + 600_000, NOW)).toBe("10 min");   // a ten-minute code, just minted
    expect(validUntil(NOW + 541_000, NOW)).toBe("10 min");   // 9:01 left rounds up
    expect(validUntil(NOW + 540_000, NOW)).toBe("9 min");
    expect(validUntil(NOW + 1_000, NOW)).toBe("1 min");
    expect(validUntil(NOW - 1_000, NOW)).toBe("1 min");      // already gone: still a minute, never zero
  });
});
