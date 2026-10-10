// Validator f13: an item that gives only the new short form (title, summary), without question/item/what.
// Synthetic data only.
import { describe, expect, it } from "vitest";
import { parseLedger } from "../src/adapters/ledger.ts";

describe("f13: an item with a title but no question", () => {
  it("its long title is not the bare id", () => {
    const summary = "Sign it at the office before noon.";
    const [i] = parseLedger({ needsYou: [{ id: "ny-200", kind: "time", title: "Sign the lease", summary }] });
    if (!i) throw new Error("not read");
    expect(i.shortTitle).toBe("Sign the lease");
    expect(i.title).not.toBe("ny-200");
    expect(["Sign the lease", summary]).toContain(i.title);
  });
});
