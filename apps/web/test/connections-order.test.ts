// Dragging an entry drops it at the target index, not one step toward it.
import { describe, expect, it } from "vitest";
import { moveTo, ownSaveOrder, swap } from "../src/lib/connections/order.ts";

describe("priority drag and drop", () => {
  it("moves an entry to the dropped position", () => {
    expect(moveTo(["a", "b", "c", "d"], 0, 3)).toEqual(["b", "c", "d", "a"]);
    expect(moveTo(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveTo(["a", "b", "c", "d"], 1, 1)).toEqual(["a", "b", "c", "d"]);
  });

  it("seeds an empty own order from the chain and never saves an empty one", () => {
    expect(ownSaveOrder([], ["key-a:m", "sub-a:m", "key-a:m"])).toEqual(["key-a", "sub-a"]);
    expect(ownSaveOrder(["sub-a"], ["key-a:m"])).toEqual(["sub-a"]);
    expect(ownSaveOrder([], [])).toBeNull();
  });

  it("swaps an entry with its neighbor and stays put at the ends", () => {
    expect(swap(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(swap(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(swap(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
  });
});
