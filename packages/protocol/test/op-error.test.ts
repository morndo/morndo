// How an op error reads, from one definition for every end (§5.3).
import { describe, expect, it } from "vitest";
import { ERROR_EXECUTED, SEND_PROBLEMS, readOpError } from "../src/index.ts";

describe("readOpError", () => {
  it("keeps every known code with the executed it came with", () => {
    for (const code of Object.keys(ERROR_EXECUTED)) expect(readOpError(code, "no", "m")).toEqual({ code, executed: "no", message: "m" });
  });
  it("reads a code nobody knows as internal and maybe, whatever it claimed", () => {
    expect(readOpError("new_code", "no", "m")).toEqual({ code: "internal", executed: "maybe", message: "m" });
  });
  it("exports the send problems the hub checks an answer against", () => {
    expect([...SEND_PROBLEMS].sort()).toEqual(["busy", "draft_present", "menu_open", "no_input_box", "no_pane", "not_submitted"]);
  });
});
