// unreachable (ADR-0008, A3; design reference: Signal-Desktop's missingCaseError): the default of every switch over a
// union, so a new member is a compile error, and a value the types ruled out still fails loudly at run time.
import { describe, expect, it } from "vitest";
import { unreachable } from "../src/shared.ts";

type Shape = { kind: "dot" } | { kind: "line"; length: number };
const size = (s: Shape): number => {
  switch (s.kind) {
    case "dot": return 0;
    case "line": return s.length;
    default: return unreachable(s);
  }
};

describe("unreachable", () => {
  it("is never reached for the union's own members", () => {
    expect(size({ kind: "dot" })).toBe(0);
    expect(size({ kind: "line", length: 3 })).toBe(3);
  });
  it("throws a TypeError naming the value when data the types ruled out arrives", () => {
    expect(() => size({ kind: "circle" } as unknown as Shape)).toThrow(TypeError);
    expect(() => size({ kind: "circle" } as unknown as Shape)).toThrow('Unhandled case: {"kind":"circle"}');
  });
  it("names values that JSON can't hold too", () => {
    expect(() => unreachable(undefined as never)).toThrow("Unhandled case: undefined");
    expect(() => unreachable(10n as never)).toThrow("Unhandled case: 10");
  });
  it("only accepts never: a switch that misses a member doesn't compile", () => {
    const partial = (s: Shape) => {
      // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- the forgotten member is this test's point
      switch (s.kind) {
        case "dot": return 0;
        // @ts-expect-error: "line" is not handled, so s is not never here
        default: return unreachable(s);
      }
    };
    expect(partial({ kind: "dot" })).toBe(0);
  });
});
